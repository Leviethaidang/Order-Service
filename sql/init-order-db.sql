CREATE DATABASE IF NOT EXISTS ecommerce_order_db;
USE ecommerce_order_db;

CREATE TABLE IF NOT EXISTS orders (
    order_id BIGINT AUTO_INCREMENT PRIMARY KEY,

    user_id VARCHAR(128) NOT NULL,

    source_type VARCHAR(20) NOT NULL, -- CART, BUY_NOW

    receiver_name VARCHAR(100) NOT NULL,
    receiver_phone VARCHAR(30) NOT NULL,
    shipping_address TEXT NOT NULL,

    payment_method_id BIGINT NOT NULL,
    payment_method_type VARCHAR(20) NOT NULL, -- MOMO, BANK
    payment_method_display_name VARCHAR(255) NOT NULL,

    order_status VARCHAR(30) NOT NULL DEFAULT 'PENDING_PAYMENT',
    payment_status VARCHAR(30) NOT NULL DEFAULT 'PENDING',

    total_quantity INT NOT NULL DEFAULT 0,
    total_amount DECIMAL(12,2) NOT NULL DEFAULT 0,

    payment_request_message_id VARCHAR(255),
    payment_transaction_id VARCHAR(255),
    payment_error TEXT,
    paid_at TIMESTAMP NULL,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS order_items (
    order_item_id BIGINT AUTO_INCREMENT PRIMARY KEY,

    order_id BIGINT NOT NULL,
    product_id INT NOT NULL,

    product_name VARCHAR(200) NOT NULL,
    category_name VARCHAR(100),
    image_url VARCHAR(1000),

    unit_price DECIMAL(12,2) NOT NULL,
    quantity INT NOT NULL,
    subtotal DECIMAL(12,2) NOT NULL,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_order_items_order
        FOREIGN KEY (order_id)
        REFERENCES orders(order_id)
        ON DELETE CASCADE
);