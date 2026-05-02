package com.yourorg.paymentwallet.exception;

import org.springframework.http.HttpStatus;

public interface ApiException {
    HttpStatus getStatus();
    String getErrorCode();
    String getMessage();
};