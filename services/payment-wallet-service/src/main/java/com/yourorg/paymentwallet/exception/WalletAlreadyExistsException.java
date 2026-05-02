package com.yourorg.paymentwallet.exception;

import org.springframework.http.HttpStatus;

public class WalletAlreadyExistsException extends BaseApiException {
    public WalletAlreadyExistsException(String message) {
        super(HttpStatus.CONFLICT, "WALLET_ALREADY_EXISTS", message);
    }
}
