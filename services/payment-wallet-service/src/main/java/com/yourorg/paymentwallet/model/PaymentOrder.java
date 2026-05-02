package com.yourorg.paymentwallet.model;

import jakarta.persistence.*;
import lombok.*;
import java.math.BigDecimal;
import java.time.LocalDateTime;

@Entity
@Table(name = "payment_order")
@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class PaymentOrder {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    private String razorpayOrderId;
    private String razorpayPaymentId;
    private String razorpayRefundId;

    @Column(nullable = false)
    private Long walletId;

    @Column(nullable = false, precision = 19, scale = 2)
    private BigDecimal amount;

    @Column(nullable = false)
    @Builder.Default
    private String currency = "INR";

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    @Builder.Default
    private PaymentStatus status = PaymentStatus.PENDING;

    private String description;
    private String failureReason;
    private String failureCode;

    @Enumerated(EnumType.STRING)
    @Builder.Default
    private PaymentMethod paymentMethod = PaymentMethod.CARD;

    private String customerEmail;
    private String customerPhone;

    @Builder.Default
    private LocalDateTime createdAt = LocalDateTime.now();

    private LocalDateTime authorizedAt;
    private LocalDateTime capturedAt;
    private LocalDateTime failedAt;
    private LocalDateTime refundedAt;

    public enum PaymentStatus {
        PENDING, AUTHORIZED, CAPTURED, FAILED, CANCELLED, REFUNDED
    }

    @PrePersist
    protected void onCreate() {
        createdAt = LocalDateTime.now();
    }

    public enum PaymentMethod {
        CARD, UPI, NETBANKING, WALLET, EMANDATE
    }
}