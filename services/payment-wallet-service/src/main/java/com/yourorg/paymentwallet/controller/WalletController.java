package com.yourorg.paymentwallet.controller;

import com.yourorg.paymentwallet.dto.CreateWalletRequest;
import com.yourorg.paymentwallet.dto.TransactionRequest;
import com.yourorg.paymentwallet.model.Transaction;
import com.yourorg.paymentwallet.model.Wallet;
import com.yourorg.paymentwallet.service.WalletService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/api/wallet")
@RequiredArgsConstructor
public class WalletController {
    private final WalletService walletService;

    @PostMapping("")
    public ResponseEntity<Wallet> createWallet(@Valid @RequestBody CreateWalletRequest request) {
        Wallet wallet = walletService.createWallet(
                request.getUserId(), 
                request.getUserType(), 
                request.getCurrency()
        );
        return ResponseEntity.ok(wallet);
    }


    @GetMapping("/health")
    public String health() {
        return "Wallet Service is Running!";
    }

    @GetMapping("/{userId}")
    public ResponseEntity<Wallet> getWallet(@PathVariable Long userId) {
        return ResponseEntity.ok(walletService.getWallet(userId));
    }

    @GetMapping("/{userId}/transactions")
    public ResponseEntity<List<Transaction>> getTransactions(@PathVariable Long userId) {
        return ResponseEntity.ok(walletService.getTransactions(userId));
    }

    @PostMapping("/{userId}/credit")
    public ResponseEntity<Wallet> creditWallet(
            @PathVariable Long userId, 
            @Valid @RequestBody TransactionRequest request) {
        return ResponseEntity.ok(walletService.creditWallet(
                userId, 
                request.getAmount(), 
                request.getDescription()
        ));
    }

    @PostMapping("/{userId}/debit")
    public ResponseEntity<Wallet> debitWallet(
            @PathVariable Long userId, 
            @Valid @RequestBody TransactionRequest request) {
        return ResponseEntity.ok(walletService.debitWallet(
                userId, 
                request.getAmount(), 
                request.getDescription()
        ));
    }
}
