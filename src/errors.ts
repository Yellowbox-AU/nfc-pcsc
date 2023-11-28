"use strict";


export const UNKNOWN_ERROR = 'unknown_error';

export class BaseError extends Error {
	previous?: Error
	/** previousError must be passed when message is nullish */
	constructor(public code: string | null, message?: string | null, public previousError?: Error) {

		super(message || undefined);
		
		Error.captureStackTrace(this, this.constructor);
		
		this.name = 'BaseError';
		
		if (!message && previousError) {
			this.message = previousError.message;
		}

		if (previousError) {
			this.previous = previousError;
		}

	}

}

export const FAILURE = 'failure';
export const CARD_NOT_CONNECTED = 'card_not_connected';
export const OPERATION_FAILED = 'operation_failed';

export class TransmitError extends BaseError {

	constructor(...params: ConstructorParameters<typeof BaseError>) {

		super(...params);

		this.name = 'TransmitError';

	}

}

export class ControlError extends BaseError {

	constructor(...params: ConstructorParameters<typeof BaseError>) {

		super(...params);

		this.name = 'ControlError';

	}

}

export class ReadError extends BaseError {

	constructor(...params: ConstructorParameters<typeof BaseError>) {

		super(...params);

		this.name = 'ReadError';

	}

}

export class WriteError extends BaseError {

	constructor(...params: ConstructorParameters<typeof BaseError>) {

		super(...params);

		this.name = 'WriteError';

	}

}

export class LoadAuthenticationKeyError extends BaseError {

	constructor(...params: ConstructorParameters<typeof BaseError>) {

		super(...params);

		this.name = 'LoadAuthenticationKeyError';

	}

}

export class AuthenticationError extends BaseError {

	constructor(...params: ConstructorParameters<typeof BaseError>) {

		super(...params);

		this.name = 'AuthenticationError';

	}

}

export class ConnectError extends BaseError {

	constructor(...params: ConstructorParameters<typeof BaseError>) {

		super(...params);

		this.name = 'ConnectError';

	}

}

export class DisconnectError extends BaseError {

	constructor(...params: ConstructorParameters<typeof BaseError>) {

		super(...params);

		this.name = 'DisconnectError';

	}

}

export class GetUIDError extends BaseError {

	constructor(...params: ConstructorParameters<typeof BaseError>) {

		super(...params);

		this.name = 'GetUIDError';

	}

}
