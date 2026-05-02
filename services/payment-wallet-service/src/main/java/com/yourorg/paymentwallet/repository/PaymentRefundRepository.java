package com.yourorg.paymentwallet.repository;

import com.yourorg.paymentwallet.model.PaymentRefund;
import org.springframework.data.jpa.repository.JpaRepository;
import java.util.List;
import java.util.Optional;

public interface PaymentRefundRepository extends JpaRepository<PaymentRefund, Long> {
    Optional<PaymentRefund> findByRazorpayRefundId(String razorpayRefundId);
    List<PaymentRefund> findByPaymentOrderId(Long paymentOrderId);
}

