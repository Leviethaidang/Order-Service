CREATE DATABASE IF NOT EXISTS ecommerce_order_db;
USE ecommerce_order_db;

CREATE TABLE IF NOT EXISTS orders (
    order_id BIGINT AUTO_INCREMENT PRIMARY KEY,

    user_id VARCHAR(128) NOT NULL,

    -- CART hoặc BUY_NOW
    source_type VARCHAR(20) NOT NULL,

    receiver_name VARCHAR(100) NOT NULL,
    receiver_phone VARCHAR(30) NOT NULL,
    shipping_address TEXT NOT NULL,

    payment_method_id BIGINT NOT NULL,

    -- COD, MOMO, BANK
    payment_method_type VARCHAR(20) NOT NULL,
    payment_method_display_name VARCHAR(255) NOT NULL,

    -- PENDING_PAYMENT, CONFIRMED, PAYMENT_FAILED, SHIPPING, COMPLETED, CANCELLED
    order_status VARCHAR(30) NOT NULL DEFAULT 'PENDING_PAYMENT',

    -- PENDING, PAID, FAILED, UNPAID
    payment_status VARCHAR(30) NOT NULL DEFAULT 'PENDING',

    total_quantity INT NOT NULL DEFAULT 0,
    total_amount DECIMAL(12,2) NOT NULL DEFAULT 0,

    payment_request_message_id VARCHAR(255),
    payment_transaction_id VARCHAR(255),
    payment_error TEXT,
    paid_at TIMESTAMP NULL,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    INDEX idx_orders_user_id (user_id),
    INDEX idx_orders_order_status (order_status),
    INDEX idx_orders_payment_status (payment_status),
    INDEX idx_orders_created_at (created_at)
);

CREATE TABLE IF NOT EXISTS order_items (
    order_item_id BIGINT AUTO_INCREMENT PRIMARY KEY,

    order_id BIGINT NOT NULL,
    product_id INT NOT NULL,
    variant_id INT NOT NULL,

    product_name VARCHAR(200) NOT NULL,
    category_name VARCHAR(100),

    size_name VARCHAR(50),
    color_name VARCHAR(100),
    color_code VARCHAR(20),

    image_url VARCHAR(1000),

    unit_price DECIMAL(12,2) NOT NULL,
    quantity INT NOT NULL,
    subtotal DECIMAL(12,2) NOT NULL,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_order_items_order_id (order_id),
    INDEX idx_order_items_product_id (product_id),
    INDEX idx_order_items_variant_id (variant_id),

    CONSTRAINT fk_order_items_order
        FOREIGN KEY (order_id)
        REFERENCES orders(order_id)
        ON DELETE CASCADE
);