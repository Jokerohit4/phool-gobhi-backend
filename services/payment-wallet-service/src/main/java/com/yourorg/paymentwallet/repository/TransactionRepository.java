package com.yourorg.paymentwallet.repository;

import com.yourorg.paymentwallet.model.Transaction;
import com.yourorg.paymentwallet.model.Wallet;
import org.springframework.data.jpa.repository.JpaRepository;
import java.util.List;

public interface TransactionRepository extends JpaRepository<Transaction, Long> {
    List<Transaction> findByWallet(Wallet wallet);
}
