package com.yourorg.paymentwallet.model;

import jakarta.persistence.*;
import lombok.*;
import java.math.BigDecimal;
import java.time.LocalDateTime;

@Entity
@Table(name = "payment_refund")
@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class PaymentRefund {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    private String razorpayRefundId;

    @Column(nullable = false)
    private Long paymentOrderId;

    @Column(nullable = false, precision = 19, scale = 2)
    private BigDecimal refundAmount;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    @Builder.Default
    private RefundStatus status = RefundStatus.PENDING;

    private String reason;
    private String notes;
    private String failureReason;

    @Builder.Default
    private LocalDateTime createdAt = LocalDateTime.now();

    private LocalDateTime processedAt;
    private LocalDateTime failedAt;

    public enum RefundStatus {
        PENDING,    // Refund initiated
        PROCESSED,  // Refund successful
        FAILED,     // Refund failed
        REVERSED    // Refund reversed
    }

    @PrePersist
    protected void onCreate() {
        createdAt = LocalDateTime.now();
    }
}