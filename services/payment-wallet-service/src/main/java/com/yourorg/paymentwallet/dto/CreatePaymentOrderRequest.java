package com.yourorg.paymentwallet.dto;

import com.yourorg.paymentwallet.validation.PositiveAmount;
import jakarta.validation.constraints.NotNull;
import lombok.Data;

import java.math.BigDecimal;

@Data
public class CreatePaymentOrderRequest {
    @NotNull(message = "walletId is required")
    private Long walletId;

    @NotNull(message = "Amount is required")
    @PositiveAmount
    private BigDecimal amount;

    private String description = "Wallet topup";
}

