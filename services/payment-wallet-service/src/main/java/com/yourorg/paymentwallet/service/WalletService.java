package com.yourorg.paymentwallet.service;

import com.yourorg.paymentwallet.exception.InsufficientBalanceException;
import com.yourorg.paymentwallet.exception.WalletAlreadyExistsException;
import com.yourorg.paymentwallet.exception.WalletNotFoundException;
import com.yourorg.paymentwallet.model.Transaction;
import com.yourorg.paymentwallet.model.Wallet;
import com.yourorg.paymentwallet.repository.TransactionRepository;
import com.yourorg.paymentwallet.repository.WalletRepository;
import jakarta.persistence.OptimisticLockException;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.retry.annotation.Backoff;
import org.springframework.retry.annotation.Retryable;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.util.List;

@Slf4j
@Service
@Transactional
@RequiredArgsConstructor
public class WalletService {
    private final WalletRepository walletRepository;
    private final TransactionRepository transactionRepository;

    public Wallet createWallet(Long userId, String userType, String currency) {
        if (walletRepository.findByUserId(userId).isPresent()) {
            throw new WalletAlreadyExistsException("Wallet already exists for user ID: " + userId);
        }
        
        Wallet wallet = Wallet.builder()
                .userId(userId)
                .userType(userType)
                .balance(BigDecimal.ZERO)
                .currency(currency)
                .status(Wallet.WalletStatus.ACTIVE)
                .createdAt(LocalDateTime.now())
                .updatedAt(LocalDateTime.now())
                .build();
        return walletRepository.save(wallet);
    }

    public Wallet getWallet(Long userId) {
        return walletRepository.findByUserId(userId)
                .orElseThrow(() -> new WalletNotFoundException("Wallet not found for user ID: " + userId));
    }

    public List<Transaction> getTransactions(Long userId) {
        Wallet wallet = getWallet(userId);
        return transactionRepository.findByWallet(wallet);
    }

    @Retryable(retryFor = {OptimisticLockException.class}, maxAttempts = 3, backoff = @Backoff(delay = 100))
    public Wallet creditWallet(Long userId, BigDecimal amount, String description) {
        Wallet wallet = getWallet(userId);
        wallet.setBalance(wallet.getBalance().add(amount));
        wallet.setUpdatedAt(LocalDateTime.now());
        try {
            walletRepository.save(wallet);
        } catch (OptimisticLockException e) {
            log.warn("Optimistic lock exception during wallet credit for user {}: {}", userId, e.getMessage());
            throw e; // Let @Retryable handle retry
        }
        Transaction tx = Transaction.builder()
                .wallet(wallet)
                .type(Transaction.TransactionType.CREDIT)
                .amount(amount)
                .currency(wallet.getCurrency())
                .status(Transaction.TransactionStatus.SUCCESS)
                .description(description)
                .createdAt(LocalDateTime.now())
                .build();
        transactionRepository.save(tx);
        return wallet;
    }

    @Retryable(retryFor = {OptimisticLockException.class}, maxAttempts = 3, backoff = @Backoff(delay = 100))
    public Wallet debitWallet(Long userId, BigDecimal amount, String description) {
        Wallet wallet = getWallet(userId);
        if (wallet.getBalance().compareTo(amount) < 0) {
            throw new InsufficientBalanceException(
                    String.format("Insufficient balance. Available: %s %s, Required: %s %s", 
                            wallet.getBalance(), wallet.getCurrency(), amount, wallet.getCurrency()));
        }
        wallet.setBalance(wallet.getBalance().subtract(amount));
        wallet.setUpdatedAt(LocalDateTime.now());
        try {
            walletRepository.save(wallet);
        } catch (OptimisticLockException e) {
            log.warn("Optimistic lock exception during wallet debit for user {}: {}", userId, e.getMessage());
            throw e; // Let @Retryable handle retry
        }
        Transaction tx = Transaction.builder()
                .wallet(wallet)
                .type(Transaction.TransactionType.DEBIT)
                .amount(amount)
                .currency(wallet.getCurrency())
                .status(Transaction.TransactionStatus.SUCCESS)
                .description(description)
                .createdAt(LocalDateTime.now())
                .build();
        transactionRepository.save(tx);
        return wallet;
    }
}
