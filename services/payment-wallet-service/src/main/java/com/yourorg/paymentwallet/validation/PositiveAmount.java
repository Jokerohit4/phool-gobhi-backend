package com.yourorg.paymentwallet.validation;

import jakarta.validation.Constraint;
import jakarta.validation.Payload;
import java.lang.annotation.*;

@Documented
@Constraint(validatedBy = PositiveAmountValidator.class)
@Target({ElementType.FIELD, ElementType.PARAMETER})
@Retention(RetentionPolicy.RUNTIME)
public @interface PositiveAmount {

    String message() default "Amount must be greater than zero";
    Class<?>[] groups() default {};
    Class<? extends Payload>[] payload() default {};
}
