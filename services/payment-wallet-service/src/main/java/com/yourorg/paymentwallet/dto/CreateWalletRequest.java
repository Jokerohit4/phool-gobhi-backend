package com.yourorg.paymentwallet.dto;

import com.yourorg.paymentwallet.validation.ValidCurrency;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import lombok.Data;

@Data
public class CreateWalletRequest {

    @NotNull(message = "userId is required")
    private Long userId;

    @NotBlank(message = "userType is required")
    private String userType;

    @ValidCurrency
    private String currency = "INR";
}
