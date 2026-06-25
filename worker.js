require('dotenv').config();

const AWS = require('aws-sdk');
const mysql = require('mysql2/promise');
const axios = require('axios');

AWS.config.update({
    region: process.env.AWS_REGION || 'ap-southeast-1'
});

const sqs = new AWS.SQS();
const sns = new AWS.SNS();

const dbPool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10
});

const PAYMENT_RESULT_QUEUE_URL = process.env.PAYMENT_RESULT_QUEUE_URL;

if (!PAYMENT_RESULT_QUEUE_URL) {
    console.error('Thiếu PAYMENT_RESULT_QUEUE_URL trong .env');
    process.exit(1);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function parseSqsMessageBody(body) {
    const parsed = JSON.parse(body);

    if (parsed.eventType) {
        return parsed;
    }

    if (parsed.Message) {
        return JSON.parse(parsed.Message);
    }

    return parsed;
}

function validatePaymentResultEvent(event) {
    if (!event) {
        throw new Error('Message rỗng!');
    }

    if (event.eventType !== 'PaymentResult') {
        throw new Error(`eventType không hợp lệ: ${event.eventType}`);
    }

    if (!event.orderId) {
        throw new Error('Thiếu orderId trong PaymentResult!');
    }

    if (!['PAID', 'FAILED'].includes(event.paymentStatus)) {
        throw new Error(`paymentStatus không hợp lệ: ${event.paymentStatus}`);
    }

    if (!event.paymentTransactionId) {
        throw new Error('Thiếu paymentTransactionId trong PaymentResult!');
    }

    return {
        orderId: Number(event.orderId),
        userId: event.userId || null,
        paymentStatus: event.paymentStatus,
        paymentTransactionId: event.paymentTransactionId,
        paymentError: event.paymentError || null,
        rawEvent: event
    };
}

async function getOrderForUpdate(connection, orderId) {
    const [rows] = await connection.execute(
        `
        SELECT
            order_id,
            user_id,
            source_type,
            order_status,
            payment_status,
            payment_transaction_id
        FROM orders
        WHERE order_id = ?
        FOR UPDATE
        `,
        [orderId]
    );

    return rows.length > 0 ? rows[0] : null;
}

async function applyPaymentResult(paymentResult) {
    let connection;

    try {
        connection = await dbPool.getConnection();
        await connection.beginTransaction();

        const order = await getOrderForUpdate(connection, paymentResult.orderId);

        if (!order) {
            console.log(`[SKIP] Order ${paymentResult.orderId} không tồn tại. Có thể đã bị xóa trước đó.`);
            await connection.commit();

            return {
                skipped: true,
                reason: 'ORDER_NOT_FOUND'
            };
        }

        if (paymentResult.userId && paymentResult.userId !== order.user_id) {
            throw new Error(
                `userId trong PaymentResult không khớp. event=${paymentResult.userId}, order=${order.user_id}`
            );
        }

        if (order.order_status === 'CANCELLED') {
            console.log(`[SKIP] Order ${paymentResult.orderId} đã CANCELLED, không update payment result.`);
            await connection.commit();

            return {
                skipped: true,
                reason: 'ORDER_CANCELLED'
            };
        }

        if (paymentResult.paymentStatus === 'FAILED') {
            console.log(`[FAILED] Payment FAILED. Marking order ${paymentResult.orderId} as PAYMENT_FAILED.`);

            await connection.execute(
                `
                UPDATE orders
                SET
                    order_status = 'PAYMENT_FAILED',
                    payment_status = 'FAILED',
                    payment_transaction_id = ?,
                    payment_error = ?,
                    paid_at = NULL
                WHERE order_id = ?
                `,
                [
                    paymentResult.paymentTransactionId,
                    paymentResult.paymentError,
                    paymentResult.orderId
                ]
            );

            await connection.commit();

            return {
                skipped: false,
                deleted: false,
                orderId: paymentResult.orderId,
                orderStatus: 'PAYMENT_FAILED',
                paymentStatus: 'FAILED',
                reason: paymentResult.paymentError
            };
        }

        if (order.payment_status === 'PAID' && order.payment_transaction_id) {
            console.log(`[SKIP] Order ${paymentResult.orderId} đã PAID trước đó.`);
            await connection.commit();

            return {
                skipped: true,
                reason: 'ALREADY_PAID'
            };
        }

        await connection.execute(
            `
            UPDATE orders
            SET
                order_status = 'CONFIRMED',
                payment_status = 'PAID',
                payment_transaction_id = ?,
                payment_error = NULL,
                paid_at = CURRENT_TIMESTAMP
            WHERE order_id = ?
            `,
            [
                paymentResult.paymentTransactionId,
                paymentResult.orderId
            ]
        );

        await connection.commit();
        
        let cartCleanup = null;
        if (order.source_type === 'CART') {
            cartCleanup = await clearCartForUser(order.user_id);
        }

        return {
            skipped: false,
            deleted: false,
            orderId: paymentResult.orderId,
            orderStatus: 'CONFIRMED',
            paymentStatus: 'PAID',
            cartCleanup
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

async function deleteMessage(receiptHandle) {
    await sqs.deleteMessage({
        QueueUrl: PAYMENT_RESULT_QUEUE_URL,
        ReceiptHandle: receiptHandle
    }).promise();
}

async function processMessage(message) {
    const receiptHandle = message.ReceiptHandle;

    try {
        const event = parseSqsMessageBody(message.Body);

        console.log('[MESSAGE] Received PaymentResult:', JSON.stringify(event));

        const paymentResult = validatePaymentResultEvent(event);

        const result = await applyPaymentResult(paymentResult);

        if (!result.skipped) {
            const updatedOrder = await getOrderWithItemsForNotification(paymentResult.orderId);

            if (updatedOrder) {
                if (result.orderStatus === 'CONFIRMED' && result.paymentStatus === 'PAID') {
                    const notificationRequest = await publishNotificationRequested('ORDER_CONFIRMED', updatedOrder, {
                        reason: 'PAYMENT_PAID'
                    });

                    console.log('[NOTIFICATION] ORDER_CONFIRMED requested:', notificationRequest);
                }

                if (result.orderStatus === 'PAYMENT_FAILED' && result.paymentStatus === 'FAILED') {
                    const notificationRequest = await publishNotificationRequested('ORDER_PAYMENT_FAILED', updatedOrder, {
                        reason: result.reason || 'PAYMENT_FAILED'
                    });

                    console.log('[NOTIFICATION] ORDER_PAYMENT_FAILED requested:', notificationRequest);
                }
            }
        }

        console.log('[DONE] Order updated from PaymentResult:', result);

        await deleteMessage(receiptHandle);

        console.log('[DELETE] SQS payment-result message deleted.');

    } catch (error) {
        console.error('[ERROR] Không thể xử lý PaymentResult:', error.message);

        // Không delete nếu lỗi kỹ thuật để SQS retry.
        // Nếu là message test sai orderId, nên xóa thủ công khỏi queue.
    }
}

async function pollMessages() {
    console.log('Order worker started.');
    console.log(`Listening payment result queue: ${PAYMENT_RESULT_QUEUE_URL}`);

    while (true) {
        try {
            const result = await sqs.receiveMessage({
                QueueUrl: PAYMENT_RESULT_QUEUE_URL,
                MaxNumberOfMessages: 5,
                WaitTimeSeconds: 20,
                VisibilityTimeout: 60
            }).promise();

            const messages = result.Messages || [];

            if (messages.length === 0) {
                continue;
            }

            console.log(`[POLL] Received ${messages.length} PaymentResult message(s).`);

            for (const message of messages) {
                await processMessage(message);
            }

        } catch (error) {
            console.error('[POLL ERROR]', error.message);
            await sleep(3000);
        }
    }
}

function getServiceUrl(envName) {
    const value = process.env[envName];

    if (!value) {
        throw new Error(`Thiếu ${envName} trong file .env`);
    }

    return value.replace(/\/$/, '');
}

function formatOrderRowForNotification(row) {
    return {
        orderId: row.order_id,
        userId: row.user_id,
        customerEmail: row.customer_email,
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

        paymentTransactionId: row.payment_transaction_id,
        paymentError: row.payment_error,
        paidAt: row.paid_at,

        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

function formatOrderItemRowForNotification(row) {
    return {
        orderItemId: row.order_item_id,
        orderId: row.order_id,
        productId: row.product_id,
        variantId: row.variant_id,

        productName: row.product_name,
        categoryName: row.category_name,
        sizeName: row.size_name,
        colorName: row.color_name,
        colorCode: row.color_code,

        imageUrl: row.image_url,
        unitPrice: Number(row.unit_price),
        quantity: Number(row.quantity),
        subtotal: Number(row.subtotal),
        createdAt: row.created_at
    };
}

async function getOrderWithItemsForNotification(orderId) {
    const [orderRows] = await dbPool.execute(
        `
        SELECT *
        FROM orders
        WHERE order_id = ?
        LIMIT 1
        `,
        [orderId]
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
        ...formatOrderRowForNotification(orderRows[0]),
        items: itemRows.map(formatOrderItemRowForNotification)
    };
}
async function publishNotificationRequested(eventType, order, extra = {}) {
    const topicArn = process.env.NOTIFICATION_REQUESTED_TOPIC_ARN;

    if (!topicArn) {
        console.warn(`[NOTIFICATION SKIP] Thiếu NOTIFICATION_REQUESTED_TOPIC_ARN. Bỏ qua event ${eventType}.`);

        return {
            published: false,
            reason: 'MISSING_NOTIFICATION_REQUESTED_TOPIC_ARN'
        };
    }

    if (!order || !order.orderId) {
        console.warn(`[NOTIFICATION SKIP] Order không hợp lệ cho event ${eventType}.`);

        return {
            published: false,
            reason: 'INVALID_ORDER'
        };
    }

    const message = {
        eventType,
        eventVersion: '1.0',
        notificationType: 'ORDER',
        order,
        extra,
        requestedAt: new Date().toISOString()
    };

    try {
        const result = await sns.publish({
            TopicArn: topicArn,
            Message: JSON.stringify(message),
            MessageAttributes: {
                eventType: {
                    DataType: 'String',
                    StringValue: eventType
                },
                notificationType: {
                    DataType: 'String',
                    StringValue: 'ORDER'
                },
                orderStatus: {
                    DataType: 'String',
                    StringValue: order.orderStatus || 'UNKNOWN'
                },
                paymentStatus: {
                    DataType: 'String',
                    StringValue: order.paymentStatus || 'UNKNOWN'
                }
            }
        }).promise();

        return {
            published: true,
            messageId: result.MessageId
        };

    } catch (error) {
        console.error(`[NOTIFICATION ERROR] Không publish được ${eventType}:`, error.message);

        return {
            published: false,
            reason: 'SNS_PUBLISH_FAILED',
            error: error.message
        };
    }
}

async function clearCartForUser(userId) {
    try {
        const baseUrl = getServiceUrl('CART_SERVICE_URL');

        if (!process.env.INTERNAL_API_KEY) {
            throw new Error('Thiếu INTERNAL_API_KEY trong Order Worker .env');
        }

        const response = await axios.delete(
            `${baseUrl}/api/cart/internal/users/${encodeURIComponent(userId)}`,
            {
                headers: {
                    'x-internal-api-key': process.env.INTERNAL_API_KEY
                },
                timeout: 5000
            }
        );

        return {
            cleared: true,
            data: response.data
        };

    } catch (error) {
        console.error(
            '[CART CLEANUP ERROR]',
            error.response?.data || error.message
        );

        return {
            cleared: false,
            error: error.response?.data?.error || error.message
        };
    }
}

process.on('SIGINT', async () => {
    console.log('Order worker received SIGINT. Exiting...');
    await dbPool.end();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('Order worker received SIGTERM. Exiting...');
    await dbPool.end();
    process.exit(0);
});

pollMessages();