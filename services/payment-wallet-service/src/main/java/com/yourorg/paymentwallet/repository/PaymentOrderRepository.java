package com.yourorg.paymentwallet.repository;

import com.yourorg.paymentwallet.model.PaymentOrder;
import org.springframework.data.jpa.repository.JpaRepository;
import java.util.List;
import java.util.Optional;

public interface PaymentOrderRepository extends JpaRepository<PaymentOrder, Long> {
    Optional<PaymentOrder> findByRazorpayOrderId(String razorpayOrderId);
    List<PaymentOrder> findByWalletId(Long walletId);
    List<PaymentOrder> findByWalletIdOrderByCreatedAtDesc(Long walletId);
}