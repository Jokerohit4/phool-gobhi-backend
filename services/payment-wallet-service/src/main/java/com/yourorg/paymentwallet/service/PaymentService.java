package com.yourorg.paymentwallet.service;

import com.razorpay.RazorpayClient;
import com.razorpay.Order;
import com.razorpay.Payment;
import com.razorpay.RazorpayException;
import com.razorpay.Refund;
import com.yourorg.paymentwallet.exception.BadRequestException;
import com.yourorg.paymentwallet.exception.ForbiddenException;
import com.yourorg.paymentwallet.exception.NotFoundException;
import com.yourorg.paymentwallet.model.PaymentOrder;
import com.yourorg.paymentwallet.model.PaymentRefund;
import com.yourorg.paymentwallet.repository.PaymentOrderRepository;
import com.yourorg.paymentwallet.repository.PaymentRefundRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.json.JSONObject;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.LocalDateTime;
import java.util.List;

@Slf4j
@Service
@Transactional
@RequiredArgsConstructor
public class PaymentService {
    private final RazorpayClient razorpayClient;
    private final PaymentOrderRepository paymentOrderRepository;
    private final PaymentRefundRepository paymentRefundRepository;
    private final WalletService walletService;
    private final RazorpayWebhookService webhookService;

    public PaymentOrder createOrder(Long walletId, BigDecimal amount, String description) {
        // Verify wallet exists
        walletService.getWallet(walletId);
        
        if (amount == null || amount.compareTo(BigDecimal.ZERO) <= 0) {
            throw new BadRequestException("Amount must be greater than zero");
        }
        
        try {
            JSONObject orderRequest = new JSONObject();
            // Convert BigDecimal to paise (multiply by 100 and convert to int)
            int amountInPaise = amount.multiply(BigDecimal.valueOf(100)).intValue();
            orderRequest.put("amount", amountInPaise);
            orderRequest.put("currency", "INR");
            orderRequest.put("receipt", "wallet_" + walletId);
            orderRequest.put("notes", new JSONObject().put("description", description));

            Order razorpayOrder = razorpayClient.orders.create(orderRequest);

            PaymentOrder paymentOrder = PaymentOrder.builder()
                    .walletId(walletId)
                    .razorpayOrderId(razorpayOrder.get("id").toString())
                    .amount(amount)
                    .description(description)
                    .status(PaymentOrder.PaymentStatus.PENDING)
                    .build();

            return paymentOrderRepository.save(paymentOrder);
        } catch (RazorpayException e) {
            throw new BadRequestException("Failed to create payment order with Razorpay: " + e.getMessage());
        } catch (Exception e) {
            throw new BadRequestException("Failed to create payment order: " + e.getMessage());
        }
    }

    public void handlePaymentSuccess(String razorpayOrderId, String razorpayPaymentId, String razorpaySignature) {
        PaymentOrder paymentOrder = paymentOrderRepository.findByRazorpayOrderId(razorpayOrderId)
                .orElseThrow(() -> new NotFoundException("Payment order not found: " + razorpayOrderId));

        // Verify webhook signature for security
        if (!webhookService.verifySignature(razorpayOrderId, razorpayPaymentId, razorpaySignature)) {
            throw new ForbiddenException("Invalid webhook signature. Payment verification failed.");
        }

        // Prevent duplicate processing
        if (paymentOrder.getStatus() == PaymentOrder.PaymentStatus.CAPTURED) {
            return; // Already processed
        }

        paymentOrder.setRazorpayPaymentId(razorpayPaymentId);
        paymentOrder.setStatus(PaymentOrder.PaymentStatus.CAPTURED);
        paymentOrder.setCapturedAt(java.time.LocalDateTime.now());
        paymentOrderRepository.save(paymentOrder);

        // Credit the wallet
        walletService.creditWallet(paymentOrder.getWalletId(), paymentOrder.getAmount(),
                "Payment received: " + razorpayPaymentId);
    }

    public void handlePaymentFailure(String razorpayOrderId) {
        PaymentOrder paymentOrder = paymentOrderRepository.findByRazorpayOrderId(razorpayOrderId)
                .orElseThrow(() -> new NotFoundException("Payment order not found: " + razorpayOrderId));

        paymentOrder.setStatus(PaymentOrder.PaymentStatus.FAILED);
        paymentOrder.setFailedAt(LocalDateTime.now());
        paymentOrderRepository.save(paymentOrder);
    }

    public PaymentOrder getPaymentOrder(Long orderId) {
        return paymentOrderRepository.findById(orderId)
                .orElseThrow(() -> new NotFoundException("Payment order not found: " + orderId));
    }

    public PaymentOrder getPaymentOrderByRazorpayOrderId(String razorpayOrderId) {
        return paymentOrderRepository.findByRazorpayOrderId(razorpayOrderId)
                .orElseThrow(() -> new NotFoundException("Payment order not found: " + razorpayOrderId));
    }

    public List<PaymentOrder> getPaymentOrdersByWallet(Long walletId) {
        return paymentOrderRepository.findByWalletIdOrderByCreatedAtDesc(walletId);
    }

    public PaymentOrder verifyPaymentStatus(String razorpayOrderId) {
        PaymentOrder paymentOrder = paymentOrderRepository.findByRazorpayOrderId(razorpayOrderId)
                .orElseThrow(() -> new NotFoundException("Payment order not found: " + razorpayOrderId));

        // If already captured, return as is
        if (paymentOrder.getStatus() == PaymentOrder.PaymentStatus.CAPTURED) {
            return paymentOrder;
        }

        // Check with Razorpay for latest status
        try {
            Order razorpayOrder = razorpayClient.orders.fetch(razorpayOrderId);
            Object statusObj = razorpayOrder.get("status");
            String status = statusObj != null ? statusObj.toString() : null;

            // Update local status if different
            if ("paid".equals(status) && paymentOrder.getStatus() != PaymentOrder.PaymentStatus.CAPTURED) {
                // Payment was captured but webhook might have been missed
                // Try to get payment ID from payments array
                String paymentId = null;
                try {
                    Object paymentsObj = razorpayOrder.get("payments");
                    if (paymentsObj != null && paymentsObj instanceof org.json.JSONArray) {
                        org.json.JSONArray payments = (org.json.JSONArray) paymentsObj;
                        if (payments.length() > 0) {
                            Object paymentObj = payments.get(0);
                            if (paymentObj instanceof org.json.JSONObject) {
                                org.json.JSONObject payment = (org.json.JSONObject) paymentObj;
                                paymentId = payment.optString("id", null);
                            }
                        }
                    }
                } catch (Exception e) {
                    log.debug("Could not extract payment ID from order: {}", e.getMessage());
                }

                if (paymentId != null && !paymentId.isEmpty()) {
                    paymentOrder.setRazorpayPaymentId(paymentId);
                    paymentOrder.setStatus(PaymentOrder.PaymentStatus.CAPTURED);
                    paymentOrder.setCapturedAt(LocalDateTime.now());
                    paymentOrderRepository.save(paymentOrder);

                    // Credit wallet if not already credited
                    walletService.creditWallet(paymentOrder.getWalletId(), paymentOrder.getAmount(),
                            "Payment verified: " + paymentId);
                }
            } else if ("attempted".equals(status) && paymentOrder.getStatus() == PaymentOrder.PaymentStatus.PENDING) {
                paymentOrder.setStatus(PaymentOrder.PaymentStatus.AUTHORIZED);
                paymentOrder.setAuthorizedAt(LocalDateTime.now());
                paymentOrderRepository.save(paymentOrder);
            }
        } catch (RazorpayException e) {
            log.warn("Failed to fetch order status from Razorpay: {}", e.getMessage());
            // Return local status if Razorpay fetch fails
        }

        return paymentOrder;
    }

    public PaymentRefund createRefund(Long paymentOrderId, BigDecimal refundAmount, String reason) {
        PaymentOrder paymentOrder = paymentOrderRepository.findById(paymentOrderId)
                .orElseThrow(() -> new NotFoundException("Payment order not found: " + paymentOrderId));

        // Validate refund
        if (paymentOrder.getStatus() != PaymentOrder.PaymentStatus.CAPTURED) {
            throw new BadRequestException("Can only refund captured payments. Current status: " + paymentOrder.getStatus());
        }

        if (refundAmount == null || refundAmount.compareTo(BigDecimal.ZERO) <= 0) {
            throw new BadRequestException("Refund amount must be greater than zero");
        }

        if (refundAmount.compareTo(paymentOrder.getAmount()) > 0) {
            throw new BadRequestException("Refund amount cannot exceed payment amount");
        }

        // Check if payment ID exists
        if (paymentOrder.getRazorpayPaymentId() == null || paymentOrder.getRazorpayPaymentId().isEmpty()) {
            throw new BadRequestException("Payment ID not found. Cannot process refund.");
        }

        try {
            JSONObject refundRequest = new JSONObject();
            int refundAmountInPaise = refundAmount.multiply(BigDecimal.valueOf(100)).intValue();
            refundRequest.put("amount", refundAmountInPaise);
            refundRequest.put("notes", new JSONObject()
                    .put("reason", reason != null ? reason : "Customer request")
                    .put("payment_order_id", paymentOrderId));

            Refund razorpayRefund = razorpayClient.payments.refund(paymentOrder.getRazorpayPaymentId(), refundRequest);

            PaymentRefund refund = PaymentRefund.builder()
                    .paymentOrderId(paymentOrderId)
                    .razorpayRefundId(razorpayRefund.get("id").toString())
                    .refundAmount(refundAmount)
                    .reason(reason)
                    .status(PaymentRefund.RefundStatus.PROCESSED)
                    .processedAt(LocalDateTime.now())
                    .build();

            refund = paymentRefundRepository.save(refund);

            // Update payment order
            paymentOrder.setRazorpayRefundId(razorpayRefund.get("id").toString());
            if (refundAmount.compareTo(paymentOrder.getAmount()) == 0) {
                paymentOrder.setStatus(PaymentOrder.PaymentStatus.REFUNDED);
            }
            paymentOrder.setRefundedAt(LocalDateTime.now());
            paymentOrderRepository.save(paymentOrder);

            // Debit wallet for refund
            walletService.debitWallet(paymentOrder.getWalletId(), refundAmount,
                    "Refund processed: " + razorpayRefund.get("id"));

            return refund;
        } catch (RazorpayException e) {
            log.error("Failed to create refund with Razorpay: {}", e.getMessage());
            throw new BadRequestException("Failed to create refund: " + e.getMessage());
        }
    }

    public List<PaymentRefund> getRefundsByPaymentOrder(Long paymentOrderId) {
        return paymentRefundRepository.findByPaymentOrderId(paymentOrderId);
    }
}