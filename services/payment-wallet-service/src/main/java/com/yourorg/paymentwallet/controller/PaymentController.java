package com.yourorg.paymentwallet.controller;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.yourorg.paymentwallet.dto.CreatePaymentOrderRequest;
import com.yourorg.paymentwallet.dto.CreateRefundRequest;
import com.yourorg.paymentwallet.dto.PaymentWebhookRequest;
import com.yourorg.paymentwallet.dto.RazorpayWebhookPayload;
import com.yourorg.paymentwallet.model.PaymentOrder;
import com.yourorg.paymentwallet.model.PaymentRefund;
import com.yourorg.paymentwallet.service.PaymentService;
import com.yourorg.paymentwallet.service.RazorpayWebhookService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/api/payment")
@RequiredArgsConstructor
public class PaymentController {
    private final PaymentService paymentService;
    private final RazorpayWebhookService webhookService;
    private final ObjectMapper objectMapper;

    @PostMapping("/order")
    public ResponseEntity<PaymentOrder> createPaymentOrder(@Valid @RequestBody CreatePaymentOrderRequest request) {
        PaymentOrder order = paymentService.createOrder(
                request.getWalletId(), 
                request.getAmount(), 
                request.getDescription()
        );
        return ResponseEntity.ok(order);
    }

    /**
     * Handles Razorpay webhook events
     * Supports both formats:
     * 1. Simple format: {razorpay_order_id, razorpay_payment_id, razorpay_signature}
     * 2. Razorpay standard format: {event, payload} with X-Razorpay-Signature header
     */
    @PostMapping("/webhook")
    public ResponseEntity<String> handleWebhook(
            HttpServletRequest httpRequest,
            @RequestBody(required = false) String rawBody) {
        try {
            // Try to parse as Razorpay standard webhook format first
            String signatureHeader = httpRequest.getHeader("X-Razorpay-Signature");
            
            if (signatureHeader != null && rawBody != null) {
                // Razorpay standard webhook format
                if (!webhookService.verifyWebhookSignature(rawBody, signatureHeader)) {
                    return ResponseEntity.status(403).body("Invalid webhook signature");
                }
                
                RazorpayWebhookPayload payload = objectMapper.readValue(rawBody, RazorpayWebhookPayload.class);
                
                if ("payment.captured".equals(payload.getEvent()) && payload.getPayload() != null 
                    && payload.getPayload().getPayment() != null 
                    && payload.getPayload().getPayment().getEntity() != null) {
                    
                    String orderId = payload.getPayload().getPayment().getEntity().getOrderId();
                    String paymentId = payload.getPayload().getPayment().getEntity().getId();
                    
                    paymentService.handlePaymentSuccess(orderId, paymentId, signatureHeader);
                    return ResponseEntity.ok("Payment processed successfully");
                } else if ("payment.failed".equals(payload.getEvent()) && payload.getPayload() != null 
                    && payload.getPayload().getPayment() != null 
                    && payload.getPayload().getPayment().getEntity() != null) {
                    
                    String orderId = payload.getPayload().getPayment().getEntity().getOrderId();
                    paymentService.handlePaymentFailure(orderId);
                    return ResponseEntity.ok("Payment failure processed");
                }
                
                return ResponseEntity.ok("Webhook received but event not handled");
            } else {
                // Fallback to simple format (for testing)
                if (rawBody == null || rawBody.trim().isEmpty()) {
                    return ResponseEntity.badRequest().body("Request body is required");
                }
                
                PaymentWebhookRequest request = objectMapper.readValue(rawBody, PaymentWebhookRequest.class);
                
                if (!webhookService.verifySignature(
                        request.getRazorpay_order_id(),
                        request.getRazorpay_payment_id(),
                        request.getRazorpay_signature())) {
                    return ResponseEntity.status(403).body("Invalid webhook signature");
                }
                
                paymentService.handlePaymentSuccess(
                        request.getRazorpay_order_id(),
                        request.getRazorpay_payment_id(),
                        request.getRazorpay_signature()
                );
                return ResponseEntity.ok("Payment processed successfully");
            }
        } catch (Exception e) {
            // Try to extract order ID for failure handling
            try {
                if (rawBody != null) {
                    RazorpayWebhookPayload payload = objectMapper.readValue(rawBody, RazorpayWebhookPayload.class);
                    if (payload.getPayload() != null && payload.getPayload().getPayment() != null 
                        && payload.getPayload().getPayment().getEntity() != null) {
                        String orderId = payload.getPayload().getPayment().getEntity().getOrderId();
                        if (orderId != null) {
                            paymentService.handlePaymentFailure(orderId);
                        }
                    }
                }
            } catch (Exception ignored) {}
            
            return ResponseEntity.badRequest().body("Payment processing failed: " + e.getMessage());
        }
    }

    @GetMapping("/order/{orderId}")
    public ResponseEntity<PaymentOrder> getPaymentOrder(@PathVariable Long orderId) {
        return ResponseEntity.ok(paymentService.getPaymentOrder(orderId));
    }

    @GetMapping("/order/razorpay/{razorpayOrderId}")
    public ResponseEntity<PaymentOrder> getPaymentOrderByRazorpayId(@PathVariable String razorpayOrderId) {
        return ResponseEntity.ok(paymentService.getPaymentOrderByRazorpayOrderId(razorpayOrderId));
    }

    @GetMapping("/order/wallet/{walletId}")
    public ResponseEntity<List<PaymentOrder>> getPaymentOrdersByWallet(@PathVariable Long walletId) {
        return ResponseEntity.ok(paymentService.getPaymentOrdersByWallet(walletId));
    }

    @GetMapping("/order/{razorpayOrderId}/verify")
    public ResponseEntity<PaymentOrder> verifyPaymentStatus(@PathVariable String razorpayOrderId) {
        return ResponseEntity.ok(paymentService.verifyPaymentStatus(razorpayOrderId));
    }

    @PostMapping("/order/{orderId}/refund")
    public ResponseEntity<PaymentRefund> createRefund(
            @PathVariable Long orderId,
            @Valid @RequestBody CreateRefundRequest request) {
        return ResponseEntity.ok(paymentService.createRefund(
                orderId,
                request.getRefundAmount(),
                request.getReason()
        ));
    }

    @GetMapping("/order/{orderId}/refunds")
    public ResponseEntity<List<PaymentRefund>> getRefunds(@PathVariable Long orderId) {
        return ResponseEntity.ok(paymentService.getRefundsByPaymentOrder(orderId));
    }
}