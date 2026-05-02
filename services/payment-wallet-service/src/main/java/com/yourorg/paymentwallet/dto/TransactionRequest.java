package com.yourorg.paymentwallet.dto;

import com.yourorg.paymentwallet.validation.PositiveAmount;
import jakarta.validation.constraints.NotNull;
import lombok.Data;

import java.math.BigDecimal;

@Data
public class TransactionRequest {

    @NotNull(message = "Amount is required")
    @PositiveAmount
    private BigDecimal amount;

    private String description = "";
}
