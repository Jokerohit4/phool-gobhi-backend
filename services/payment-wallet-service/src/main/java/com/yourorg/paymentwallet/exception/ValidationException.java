package com.yourorg.paymentwallet.exception;

import org.springframework.http.HttpStatus;

public class ValidationException extends BaseApiException {
  public ValidationException(String message) {
    super(HttpStatus.UNPROCESSABLE_ENTITY, "VALIDATION_ERROR", message);
  }
}
