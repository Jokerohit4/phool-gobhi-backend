package com.yourorg.paymentwallet.exception;

import org.springframework.http.HttpStatus;

public class WalletNotFoundException extends BaseApiException {
    public WalletNotFoundException(String message) {
        super(HttpStatus.NOT_FOUND, "WALLET_NOT_FOUND", message);
    }
}
