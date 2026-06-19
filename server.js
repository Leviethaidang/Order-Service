require('dotenv').config();

const express = require('express');
const mysql = require('mysql2/promise');
const axios = require('axios');
const cors = require('cors');
const AWS = require('aws-sdk');
const { CognitoJwtVerifier } = require('aws-jwt-verify');

const app = express();

app.use(cors());
app.use(express.json());

// ================================
// DATABASE POOL
// ================================
const dbPool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10
});

// ================================
// AWS SNS CONFIG
// ================================
AWS.config.update({
    region: process.env.AWS_REGION || 'ap-southeast-1'
});

const sns = new AWS.SNS();

// ================================
// COGNITO JWT VERIFIER
// ================================
const verifier = CognitoJwtVerifier.create({
    userPoolId: process.env.COGNITO_USER_POOL_ID,
    tokenUse: 'access',
    clientId: process.env.COGNITO_APP_CLIENT_ID
});

// ================================
// CONSTANTS
// ================================
const ORDER_STATUSES = [
    'PENDING_PAYMENT',
    'CONFIRMED',
    'PAYMENT_FAILED',
    'SHIPPING',
    'COMPLETED',
    'CANCELLED'
];

const PAYMENT_STATUSES = [
    'PENDING',
    'PAID',
    'FAILED',
    'UNPAID'
];

const SUPPORTED_PAYMENT_METHODS = ['MOMO', 'BANK'];

// ================================
// ERROR HELPER
// ================================
class ClientError extends Error {
    constructor(statusCode, message) {
        super(message);
        this.statusCode = statusCode;
    }
}

function handleRouteError(res, error, fallbackMessage) {
    console.error(fallbackMessage, error);

    if (error instanceof ClientError) {
        return res.status(error.statusCode).json({
            error: error.message
        });
    }

    return res.status(500).json({
        error: error.message || fallbackMessage
    });
}

// ================================
// BASIC HELPERS
// ================================
function getServiceUrl(envName) {
    const value = process.env[envName];

    if (!value) {
        throw new Error(`Thiếu ${envName} trong file .env`);
    }

    return value.replace(/\/$/, '');
}

function buildAuthHeaders(accessToken) {
    return {
        Authorization: `Bearer ${accessToken}`
    };
}

function parsePositiveInteger(value) {
    const numberValue = Number(value);

    if (!Number.isInteger(numberValue) || numberValue <= 0) {
        return null;
    }

    return numberValue;
}

function normalizeString(value) {
    if (value === undefined || value === null) {
        return '';
    }

    return String(value).trim();
}

function roundMoney(value) {
    return Math.round(Number(value) * 100) / 100;
}

function formatOrderRow(row) {
    if (!row) return null;

    return {
        orderId: row.order_id,
        userId: row.user_id,
        sourceType: row.source_type,

        receiverName: row.receiver_name,
        receiverPhone: row.receiver_phone,
        shippingAddress: row.shipping_address,

        paymentMethodId: row.payment_method_id,
        paymentMethodType: row.payment_method_type,
        paymentMethodDisplayName: row.payment_method_display_name,

        orderStatus: row.order_status,
        paymentStatus: row.payment_status,

        totalQuantity: Number(row.total_quantity),
        totalAmount: Number(row.total_amount),

        paymentRequestMessageId: row.payment_request_message_id,
        paymentTransactionId: row.payment_transaction_id,
        paymentError: row.payment_error,
        paidAt: row.paid_at,

        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

function formatOrderItemRow(row) {
    return {
        orderItemId: row.order_item_id,
        orderId: row.order_id,
        productId: row.product_id,
        productName: row.product_name,
        categoryName: row.category_name,
        imageUrl: row.image_url,
        unitPrice: Number(row.unit_price),
        quantity: Number(row.quantity),
        subtotal: Number(row.subtotal),
        createdAt: row.created_at
    };
}

// ================================
// AUTH MIDDLEWARE
// ================================
async function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
            error: 'Không tìm thấy Token. Vui lòng đăng nhập!'
        });
    }

    const token = authHeader.split(' ')[1];

    try {
        const payload = await verifier.verify(token);

        req.user = {
            sub: payload.sub,
            username: payload.username || payload['cognito:username'] || payload.sub,
            groups: payload['cognito:groups'] || [],
            accessToken: token,
            payload
        };

        next();

    } catch (error) {
        console.error('Lỗi verify token tại Order Service:', error);

        return res.status(401).json({
            error: 'Token không hợp lệ hoặc đã hết hạn!'
        });
    }
}

function adminMiddleware(req, res, next) {
    const groups = req.user.groups || [];

    if (!groups.includes('Admin')) {
        return res.status(403).json({
            error: 'Bạn không có quyền Admin!'
        });
    }

    next();
}

function internalMiddleware(req, res, next) {
    const internalApiKey = req.headers['x-internal-api-key'];

    if (!process.env.INTERNAL_API_KEY) {
        return res.status(500).json({
            error: 'Order Service chưa cấu hình INTERNAL_API_KEY!'
        });
    }

    if (internalApiKey !== process.env.INTERNAL_API_KEY) {
        return res.status(403).json({
            error: 'Internal API key không hợp lệ!'
        });
    }

    next();
}

// ================================
// SERVICE CALLS
// ================================
async function getUserProfile(accessToken) {
    try {
        const baseUrl = getServiceUrl('USER_SERVICE_URL');

        const response = await axios.get(`${baseUrl}/api/users/me`, {
            headers: buildAuthHeaders(accessToken),
            timeout: 5000
        });

        return response.data.profile;

    } catch (error) {
        console.error('Lỗi gọi User Service:', error.response?.data || error.message);
        throw new Error('Không thể lấy thông tin người dùng từ User Service!');
    }
}

async function getPaymentMethods(accessToken) {
    try {
        const baseUrl = getServiceUrl('PAYMENT_SERVICE_URL');

        const response = await axios.get(`${baseUrl}/api/payments/me/payment-methods`, {
            headers: buildAuthHeaders(accessToken),
            timeout: 5000
        });

        return response.data.paymentMethods || [];

    } catch (error) {
        console.error('Lỗi gọi Payment Service:', error.response?.data || error.message);
        throw new Error('Không thể lấy phương thức thanh toán từ Payment Service!');
    }
}

async function getCart(accessToken) {
    try {
        const baseUrl = getServiceUrl('CART_SERVICE_URL');

        const response = await axios.get(`${baseUrl}/api/cart`, {
            headers: buildAuthHeaders(accessToken),
            timeout: 7000
        });

        return response.data.cart;

    } catch (error) {
        console.error('Lỗi gọi Cart Service:', error.response?.data || error.message);
        throw new Error('Không thể lấy giỏ hàng từ Cart Service!');
    }
}

async function getProductById(productId) {
    try {
        const baseUrl = getServiceUrl('PRODUCT_SERVICE_URL');

        const response = await axios.get(`${baseUrl}/api/products/${productId}`, {
            timeout: 5000
        });

        return response.data.product;

    } catch (error) {
        if (error.response && error.response.status === 404) {
            return null;
        }

        console.error('Lỗi gọi Product Service:', error.response?.data || error.message);
        throw new Error('Không thể lấy sản phẩm từ Product Service!');
    }
}

// ================================
// CHECKOUT HELPERS
// ================================
async function buildReceiverInfo(body, accessToken) {
    const profile = await getUserProfile(accessToken);

    const receiverName =
        normalizeString(body.receiverName) || normalizeString(profile.full_name);

    const receiverPhone =
        normalizeString(body.receiverPhone) || normalizeString(profile.phone_number);

    const shippingAddress =
        normalizeString(body.shippingAddress) || normalizeString(profile.default_shipping_address);

    if (!receiverName) {
        throw new ClientError(400, 'Vui lòng nhập tên người nhận!');
    }

    if (!receiverPhone) {
        throw new ClientError(400, 'Vui lòng nhập số điện thoại người nhận!');
    }

    if (!shippingAddress) {
        throw new ClientError(400, 'Vui lòng nhập địa chỉ giao hàng!');
    }

    return {
        receiverName,
        receiverPhone,
        shippingAddress
    };
}

async function resolvePaymentMethod(body, accessToken) {
    const paymentMethods = await getPaymentMethods(accessToken);

    if (!Array.isArray(paymentMethods) || paymentMethods.length === 0) {
        throw new ClientError(400, 'Bạn chưa có phương thức thanh toán nào!');
    }

    const requestedPaymentMethodId = body.paymentMethodId
        ? String(body.paymentMethodId)
        : null;

    let selectedPaymentMethod;

    if (requestedPaymentMethodId) {
        selectedPaymentMethod = paymentMethods.find((method) => {
            return String(method.payment_method_id) === requestedPaymentMethodId;
        });

        if (!selectedPaymentMethod) {
            throw new ClientError(400, 'Phương thức thanh toán không hợp lệ!');
        }
    } else {
        selectedPaymentMethod = paymentMethods.find((method) => {
            return Boolean(method.is_default);
        });

        if (!selectedPaymentMethod) {
            throw new ClientError(400, 'Không tìm thấy phương thức thanh toán mặc định!');
        }
    }

    const methodType = String(selectedPaymentMethod.method_type || '').toUpperCase();

    if (!SUPPORTED_PAYMENT_METHODS.includes(methodType)) {
        throw new ClientError(
            400,
            'Checkout hiện chỉ hỗ trợ MoMo hoặc Bank. COD sẽ được xử lý riêng sau.'
        );
    }

    return {
        paymentMethodId: selectedPaymentMethod.payment_method_id,
        paymentMethodType: methodType,
        paymentMethodDisplayName: selectedPaymentMethod.display_name
    };
}

async function buildCartCheckoutItems(accessToken) {
    const cart = await getCart(accessToken);

    if (!cart || !Array.isArray(cart.items) || cart.items.length === 0) {
        throw new ClientError(400, 'Giỏ hàng đang trống!');
    }

    const items = [];

    for (const cartItem of cart.items) {
        if (cartItem.productDeleted || !cartItem.product) {
            throw new ClientError(
                400,
                `Sản phẩm ${cartItem.productId} không còn tồn tại. Vui lòng xóa khỏi giỏ hàng trước khi checkout.`
            );
        }

        const product = cartItem.product;
        const quantity = Number(cartItem.quantity);
        const stockQuantity = Number(product.stockQuantity);
        const unitPrice = Number(product.price);

        if (!Number.isInteger(quantity) || quantity <= 0) {
            throw new ClientError(400, `Số lượng sản phẩm ${product.productName} không hợp lệ!`);
        }

        if (Number.isNaN(stockQuantity) || stockQuantity <= 0) {
            throw new ClientError(400, `Sản phẩm ${product.productName} đã hết hàng!`);
        }

        if (quantity > stockQuantity) {
            throw new ClientError(
                400,
                `Sản phẩm ${product.productName} vượt quá tồn kho. Tồn kho hiện tại: ${stockQuantity}`
            );
        }

        if (Number.isNaN(unitPrice) || unitPrice < 0) {
            throw new ClientError(400, `Giá sản phẩm ${product.productName} không hợp lệ!`);
        }

        const subtotal = roundMoney(unitPrice * quantity);

        items.push({
            productId: product.productId,
            productName: product.productName,
            categoryName: product.categoryName || null,
            imageUrl: product.imageUrl || null,
            unitPrice: roundMoney(unitPrice),
            quantity,
            subtotal
        });
    }

    const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
    const totalAmount = roundMoney(
        items.reduce((sum, item) => sum + item.subtotal, 0)
    );

    return {
        items,
        totalQuantity,
        totalAmount
    };
}

async function buildBuyNowCheckoutItems(body) {
    const productId = parsePositiveInteger(body.productId);
    const quantity = parsePositiveInteger(body.quantity || 1);

    if (!productId) {
        throw new ClientError(400, 'productId không hợp lệ!');
    }

    if (!quantity) {
        throw new ClientError(400, 'quantity phải là số nguyên lớn hơn 0!');
    }

    const product = await getProductById(productId);

    if (!product) {
        throw new ClientError(404, 'Sản phẩm không tồn tại!');
    }

    const stockQuantity = Number(product.stock_quantity);
    const unitPrice = Number(product.price);

    if (Number.isNaN(stockQuantity) || stockQuantity <= 0) {
        throw new ClientError(400, 'Sản phẩm đã hết hàng!');
    }

    if (quantity > stockQuantity) {
        throw new ClientError(
            400,
            `Số lượng vượt quá tồn kho. Tồn kho hiện tại: ${stockQuantity}`
        );
    }

    if (Number.isNaN(unitPrice) || unitPrice < 0) {
        throw new ClientError(400, 'Giá sản phẩm không hợp lệ!');
    }

    const subtotal = roundMoney(unitPrice * quantity);

    const items = [
        {
            productId: product.product_id,
            productName: product.product_name,
            categoryName: product.category_name || null,
            imageUrl: product.imageUrl || null,
            unitPrice: roundMoney(unitPrice),
            quantity,
            subtotal
        }
    ];

    return {
        items,
        totalQuantity: quantity,
        totalAmount: subtotal
    };
}

// ================================
// ORDER DB HELPERS
// ================================
async function createOrderInDatabase({
    userId,
    sourceType,
    receiverInfo,
    paymentMethod,
    checkoutData
}) {
    let connection;

    try {
        connection = await dbPool.getConnection();
        await connection.beginTransaction();

        const [orderResult] = await connection.execute(
            `
            INSERT INTO orders (
                user_id,
                source_type,
                receiver_name,
                receiver_phone,
                shipping_address,
                payment_method_id,
                payment_method_type,
                payment_method_display_name,
                order_status,
                payment_status,
                total_quantity,
                total_amount
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_PAYMENT', 'PENDING', ?, ?)
            `,
            [
                userId,
                sourceType,
                receiverInfo.receiverName,
                receiverInfo.receiverPhone,
                receiverInfo.shippingAddress,
                paymentMethod.paymentMethodId,
                paymentMethod.paymentMethodType,
                paymentMethod.paymentMethodDisplayName,
                checkoutData.totalQuantity,
                checkoutData.totalAmount
            ]
        );

        const orderId = orderResult.insertId;

        for (const item of checkoutData.items) {
            await connection.execute(
                `
                INSERT INTO order_items (
                    order_id,
                    product_id,
                    product_name,
                    category_name,
                    image_url,
                    unit_price,
                    quantity,
                    subtotal
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `,
                [
                    orderId,
                    item.productId,
                    item.productName,
                    item.categoryName,
                    item.imageUrl,
                    item.unitPrice,
                    item.quantity,
                    item.subtotal
                ]
            );
        }

        await connection.commit();

        return {
            orderId,
            userId,
            sourceType,
            ...receiverInfo,
            ...paymentMethod,
            orderStatus: 'PENDING_PAYMENT',
            paymentStatus: 'PENDING',
            totalQuantity: checkoutData.totalQuantity,
            totalAmount: checkoutData.totalAmount,
            items: checkoutData.items
        };

    } catch (error) {
        if (connection) {
            await connection.rollback();
        }

        throw error;

    } finally {
        if (connection) {
            connection.release();
        }
    }
}

async function getOrderWithItems(orderId, userId = null) {
    const params = [orderId];

    let whereSql = 'WHERE order_id = ?';

    if (userId) {
        whereSql += ' AND user_id = ?';
        params.push(userId);
    }

    const [orderRows] = await dbPool.execute(
        `
        SELECT *
        FROM orders
        ${whereSql}
        LIMIT 1
        `,
        params
    );

    if (orderRows.length === 0) {
        return null;
    }

    const [itemRows] = await dbPool.execute(
        `
        SELECT *
        FROM order_items
        WHERE order_id = ?
        ORDER BY order_item_id ASC
        `,
        [orderId]
    );

    return {
        ...formatOrderRow(orderRows[0]),
        items: itemRows.map(formatOrderItemRow)
    };
}

// ================================
// SNS HELPER
// ================================
async function publishPaymentRequested(order) {
    const enableSns = process.env.ENABLE_SNS === 'true';

    if (!enableSns) {
        return {
            published: false,
            reason: 'SNS_DISABLED'
        };
    }

    const topicArn = process.env.PAYMENT_REQUESTED_TOPIC_ARN;

    if (!topicArn) {
        throw new Error('Thiếu PAYMENT_REQUESTED_TOPIC_ARN trong file .env');
    }

    const message = {
        eventType: 'PaymentRequested',
        eventVersion: '1.0',
        orderId: order.orderId,
        userId: order.userId,
        amount: order.totalAmount,
        currency: 'VND',
        paymentMethod: {
            paymentMethodId: order.paymentMethodId,
            methodType: order.paymentMethodType,
            displayName: order.paymentMethodDisplayName
        },
        createdAt: new Date().toISOString()
    };

    const result = await sns.publish({
        TopicArn: topicArn,
        Message: JSON.stringify(message),
        MessageAttributes: {
            eventType: {
                DataType: 'String',
                StringValue: 'PaymentRequested'
            },
            paymentMethodType: {
                DataType: 'String',
                StringValue: order.paymentMethodType
            }
        }
    }).promise();

    await dbPool.execute(
        `
        UPDATE orders
        SET payment_request_message_id = ?
        WHERE order_id = ?
        `,
        [result.MessageId, order.orderId]
    );

    return {
        published: true,
        messageId: result.MessageId
    };
}

// =========================================================================
// ROUTE 1: CHECKOUT - TẠO ĐƠN HÀNG
// =========================================================================
app.post('/api/orders/checkout', authMiddleware, async (req, res) => {
    const userId = req.user.sub;
    const accessToken = req.user.accessToken;

    const sourceType = normalizeString(req.body.sourceType || 'CART').toUpperCase();

    if (!['CART', 'BUY_NOW'].includes(sourceType)) {
        return res.status(400).json({
            error: 'sourceType không hợp lệ. Chỉ chấp nhận CART hoặc BUY_NOW.'
        });
    }

    try {
        const receiverInfo = await buildReceiverInfo(req.body, accessToken);
        const paymentMethod = await resolvePaymentMethod(req.body, accessToken);

        const checkoutData =
            sourceType === 'CART'
                ? await buildCartCheckoutItems(accessToken)
                : await buildBuyNowCheckoutItems(req.body);

        const order = await createOrderInDatabase({
            userId,
            sourceType,
            receiverInfo,
            paymentMethod,
            checkoutData
        });

        let paymentRequest;

        try {
            paymentRequest = await publishPaymentRequested(order);
        } catch (snsError) {
            console.error('Lỗi publish PaymentRequested:', snsError);

            await dbPool.execute(
                `
                UPDATE orders
                SET
                    order_status = 'PAYMENT_FAILED',
                    payment_status = 'FAILED',
                    payment_error = ?
                WHERE order_id = ?
                `,
                [snsError.message, order.orderId]
            );

            return res.status(500).json({
                error: 'Đơn hàng đã được tạo nhưng không gửi được yêu cầu thanh toán!',
                orderId: order.orderId,
                detail: snsError.message
            });
        }

        const createdOrder = await getOrderWithItems(order.orderId, userId);

        return res.status(201).json({
            message: 'Tạo đơn hàng thành công! Đơn hàng đang chờ thanh toán.',
            order: createdOrder,
            paymentRequest
        });

    } catch (error) {
        return handleRouteError(res, error, 'Không thể checkout!');
    }
});

// =========================================================================
// ROUTE 2: USER XEM DANH SÁCH ĐƠN HÀNG CỦA MÌNH
// =========================================================================
app.get('/api/orders/me', authMiddleware, async (req, res) => {
    const userId = req.user.sub;

    try {
        const [rows] = await dbPool.execute(
            `
            SELECT *
            FROM orders
            WHERE user_id = ?
            ORDER BY created_at DESC
            `,
            [userId]
        );

        return res.json({
            message: 'Lấy danh sách đơn hàng thành công!',
            orders: rows.map(formatOrderRow)
        });

    } catch (error) {
        return handleRouteError(res, error, 'Không thể lấy danh sách đơn hàng!');
    }
});

// =========================================================================
// ROUTE 3: USER XEM CHI TIẾT ĐƠN HÀNG
// =========================================================================
app.get('/api/orders/me/:orderId', authMiddleware, async (req, res) => {
    const userId = req.user.sub;
    const orderId = parsePositiveInteger(req.params.orderId);

    if (!orderId) {
        return res.status(400).json({
            error: 'orderId không hợp lệ!'
        });
    }

    try {
        const order = await getOrderWithItems(orderId, userId);

        if (!order) {
            return res.status(404).json({
                error: 'Không tìm thấy đơn hàng!'
            });
        }

        return res.json({
            message: 'Lấy chi tiết đơn hàng thành công!',
            order
        });

    } catch (error) {
        return handleRouteError(res, error, 'Không thể lấy chi tiết đơn hàng!');
    }
});

// =========================================================================
// ROUTE 4: USER HỦY ĐƠN HÀNG
// =========================================================================
app.put('/api/orders/me/:orderId/cancel', authMiddleware, async (req, res) => {
    const userId = req.user.sub;
    const orderId = parsePositiveInteger(req.params.orderId);

    if (!orderId) {
        return res.status(400).json({
            error: 'orderId không hợp lệ!'
        });
    }

    try {
        const order = await getOrderWithItems(orderId, userId);

        if (!order) {
            return res.status(404).json({
                error: 'Không tìm thấy đơn hàng!'
            });
        }

        if (['SHIPPING', 'COMPLETED', 'CANCELLED'].includes(order.orderStatus)) {
            return res.status(400).json({
                error: `Không thể hủy đơn hàng ở trạng thái ${order.orderStatus}!`
            });
        }

        await dbPool.execute(
            `
            UPDATE orders
            SET order_status = 'CANCELLED'
            WHERE order_id = ?
              AND user_id = ?
            `,
            [orderId, userId]
        );

        const updatedOrder = await getOrderWithItems(orderId, userId);

        return res.json({
            message: 'Hủy đơn hàng thành công!',
            order: updatedOrder
        });

    } catch (error) {
        return handleRouteError(res, error, 'Không thể hủy đơn hàng!');
    }
});

// =========================================================================
// ROUTE 5: USER XÁC NHẬN ĐÃ NHẬN HÀNG
// =========================================================================
app.put('/api/orders/me/:orderId/received', authMiddleware, async (req, res) => {
    const userId = req.user.sub;
    const orderId = parsePositiveInteger(req.params.orderId);

    if (!orderId) {
        return res.status(400).json({
            error: 'orderId không hợp lệ!'
        });
    }

    try {
        const order = await getOrderWithItems(orderId, userId);

        if (!order) {
            return res.status(404).json({
                error: 'Không tìm thấy đơn hàng!'
            });
        }

        if (order.orderStatus !== 'SHIPPING') {
            return res.status(400).json({
                error: 'Chỉ đơn hàng đang giao mới có thể xác nhận đã nhận hàng!'
            });
        }

        await dbPool.execute(
            `
            UPDATE orders
            SET order_status = 'COMPLETED'
            WHERE order_id = ?
              AND user_id = ?
            `,
            [orderId, userId]
        );

        const updatedOrder = await getOrderWithItems(orderId, userId);

        return res.json({
            message: 'Xác nhận đã nhận hàng thành công!',
            order: updatedOrder
        });

    } catch (error) {
        return handleRouteError(res, error, 'Không thể xác nhận đã nhận hàng!');
    }
});

// =========================================================================
// ADMIN ROUTE 1: XEM TOÀN BỘ ĐƠN HÀNG
// =========================================================================
app.get('/api/orders/admin/orders', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const [rows] = await dbPool.execute(
            `
            SELECT *
            FROM orders
            ORDER BY created_at DESC
            `
        );

        return res.json({
            message: 'Admin lấy danh sách đơn hàng thành công!',
            orders: rows.map(formatOrderRow)
        });

    } catch (error) {
        return handleRouteError(res, error, 'Không thể lấy danh sách đơn hàng admin!');
    }
});

// =========================================================================
// ADMIN ROUTE 2: XEM CHI TIẾT ĐƠN HÀNG
// =========================================================================
app.get('/api/orders/admin/orders/:orderId', authMiddleware, adminMiddleware, async (req, res) => {
    const orderId = parsePositiveInteger(req.params.orderId);

    if (!orderId) {
        return res.status(400).json({
            error: 'orderId không hợp lệ!'
        });
    }

    try {
        const order = await getOrderWithItems(orderId);

        if (!order) {
            return res.status(404).json({
                error: 'Không tìm thấy đơn hàng!'
            });
        }

        return res.json({
            message: 'Admin lấy chi tiết đơn hàng thành công!',
            order
        });

    } catch (error) {
        return handleRouteError(res, error, 'Không thể lấy chi tiết đơn hàng admin!');
    }
});

// =========================================================================
// ADMIN ROUTE 3: ADMIN CHỈNH TRẠNG THÁI ĐƠN HÀNG
// =========================================================================
app.put('/api/orders/admin/orders/:orderId/status', authMiddleware, adminMiddleware, async (req, res) => {
    const orderId = parsePositiveInteger(req.params.orderId);

    if (!orderId) {
        return res.status(400).json({
            error: 'orderId không hợp lệ!'
        });
    }

    const nextOrderStatus =
        req.body.orderStatus !== undefined
            ? normalizeString(req.body.orderStatus).toUpperCase()
            : null;

    const nextPaymentStatus =
        req.body.paymentStatus !== undefined
            ? normalizeString(req.body.paymentStatus).toUpperCase()
            : null;

    if (!nextOrderStatus && !nextPaymentStatus) {
        return res.status(400).json({
            error: 'Vui lòng gửi orderStatus hoặc paymentStatus!'
        });
    }

    if (nextOrderStatus && !ORDER_STATUSES.includes(nextOrderStatus)) {
        return res.status(400).json({
            error: `orderStatus không hợp lệ. Chỉ chấp nhận: ${ORDER_STATUSES.join(', ')}`
        });
    }

    if (nextPaymentStatus && !PAYMENT_STATUSES.includes(nextPaymentStatus)) {
        return res.status(400).json({
            error: `paymentStatus không hợp lệ. Chỉ chấp nhận: ${PAYMENT_STATUSES.join(', ')}`
        });
    }

    try {
        const currentOrder = await getOrderWithItems(orderId);

        if (!currentOrder) {
            return res.status(404).json({
                error: 'Không tìm thấy đơn hàng!'
            });
        }

        const updateFields = [];
        const params = [];

        if (nextOrderStatus) {
            updateFields.push('order_status = ?');
            params.push(nextOrderStatus);
        }

        if (nextPaymentStatus) {
            updateFields.push('payment_status = ?');
            params.push(nextPaymentStatus);
        }

        params.push(orderId);

        await dbPool.execute(
            `
            UPDATE orders
            SET ${updateFields.join(', ')}
            WHERE order_id = ?
            `,
            params
        );

        const updatedOrder = await getOrderWithItems(orderId);

        return res.json({
            message: 'Admin cập nhật trạng thái đơn hàng thành công!',
            order: updatedOrder
        });

    } catch (error) {
        return handleRouteError(res, error, 'Không thể cập nhật trạng thái đơn hàng!');
    }
});

// =========================================================================
// INTERNAL ROUTE: PAYMENT SERVICE / WORKER CẬP NHẬT KẾT QUẢ THANH TOÁN
// =========================================================================
app.put('/api/orders/internal/:orderId/payment-result', internalMiddleware, async (req, res) => {
    const orderId = parsePositiveInteger(req.params.orderId);

    if (!orderId) {
        return res.status(400).json({
            error: 'orderId không hợp lệ!'
        });
    }

    const paymentStatus = normalizeString(req.body.paymentStatus).toUpperCase();
    const paymentTransactionId = normalizeString(req.body.paymentTransactionId) || null;
    const paymentError = normalizeString(req.body.paymentError) || null;

    if (!['PAID', 'FAILED'].includes(paymentStatus)) {
        return res.status(400).json({
            error: 'paymentStatus chỉ chấp nhận PAID hoặc FAILED!'
        });
    }

    const nextOrderStatus =
        paymentStatus === 'PAID'
            ? 'CONFIRMED'
            : 'PAYMENT_FAILED';

    try {
        const currentOrder = await getOrderWithItems(orderId);

        if (!currentOrder) {
            return res.status(404).json({
                error: 'Không tìm thấy đơn hàng!'
            });
        }

        if (currentOrder.orderStatus === 'CANCELLED') {
            return res.status(400).json({
                error: 'Không thể cập nhật thanh toán cho đơn hàng đã hủy!'
            });
        }

        await dbPool.execute(
            `
            UPDATE orders
            SET
                order_status = ?,
                payment_status = ?,
                payment_transaction_id = ?,
                payment_error = ?,
                paid_at = CASE WHEN ? = 'PAID' THEN CURRENT_TIMESTAMP ELSE paid_at END
            WHERE order_id = ?
            `,
            [
                nextOrderStatus,
                paymentStatus,
                paymentTransactionId,
                paymentError,
                paymentStatus,
                orderId
            ]
        );

        const updatedOrder = await getOrderWithItems(orderId);

        return res.json({
            message: 'Cập nhật kết quả thanh toán thành công!',
            order: updatedOrder
        });

    } catch (error) {
        return handleRouteError(res, error, 'Không thể cập nhật kết quả thanh toán!');
    }
});

// ================================
// START SERVER
// ================================
const PORT = process.env.PORT || 3004;

app.listen(PORT, () => {
    console.log(`Order Service running on port ${PORT}`);
});