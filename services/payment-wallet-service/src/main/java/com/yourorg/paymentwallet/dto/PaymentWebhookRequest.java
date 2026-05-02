package com.yourorg.paymentwallet.dto;

import jakarta.validation.constraints.NotBlank;
import lombok.Data;

@Data
public class PaymentWebhookRequest {
    @NotBlank(message = "razorpay_order_id is required")
    private String razorpay_order_id;

    @NotBlank(message = "razorpay_payment_id is required")
    private String razorpay_payment_id;

    @NotBlank(message = "razorpay_signature is required")
    private String razorpay_signature;
}

