require('dotenv').config();

const AWS = require('aws-sdk');
const mysql = require('mysql2/promise');

AWS.config.update({
    region: process.env.AWS_REGION || 'ap-southeast-1'
});

const sqs = new AWS.SQS();

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
            console.log(`[DELETE] Payment FAILED. Deleting order ${paymentResult.orderId}.`);

            await connection.execute(
                `
                DELETE FROM orders
                WHERE order_id = ?
                `,
                [paymentResult.orderId]
            );

            await connection.commit();

            return {
                skipped: false,
                deleted: true,
                orderId: paymentResult.orderId,
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

        return {
            skipped: false,
            deleted: false,
            orderId: paymentResult.orderId,
            orderStatus: 'CONFIRMED',
            paymentStatus: 'PAID'
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