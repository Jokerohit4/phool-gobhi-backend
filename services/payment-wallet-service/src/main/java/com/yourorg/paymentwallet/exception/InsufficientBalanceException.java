package com.yourorg.paymentwallet.exception;

import org.springframework.http.HttpStatus;

public class InsufficientBalanceException extends BaseApiException {
    public InsufficientBalanceException(String message) {
        super(HttpStatus.BAD_REQUEST, "INSUFFICIENT_BALANCE", message);
    }
}
