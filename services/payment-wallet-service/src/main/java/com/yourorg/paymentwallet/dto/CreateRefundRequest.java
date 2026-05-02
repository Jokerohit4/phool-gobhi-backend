package com.yourorg.paymentwallet.dto;

import com.yourorg.paymentwallet.validation.PositiveAmount;
import jakarta.validation.constraints.NotNull;
import lombok.Data;

import java.math.BigDecimal;

@Data
public class CreateRefundRequest {
    @NotNull(message = "Refund amount is required")
    @PositiveAmount
    private BigDecimal refundAmount;

    private String reason;
}

