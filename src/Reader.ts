"use strict";

import EventEmitter from 'events';
import { type CardReader } from './NFC';
import {
	ConnectError,
	DisconnectError,
	TransmitError,
	ControlError,
	AuthenticationError,
	LoadAuthenticationKeyError,
	ReadError,
	WriteError,
	GetUIDError,
	CARD_NOT_CONNECTED,
	OPERATION_FAILED,
	FAILURE,
} from './errors';


export const TAG_ISO_14443_3 = 'TAG_ISO_14443_3'; // ISO/IEC 14443-3 tags
export const TAG_ISO_14443_4 = 'TAG_ISO_14443_4'; // ISO/IEC 14443-4 tags

export const KEY_TYPE_A = 0x60;
export const KEY_TYPE_B = 0x61;

export const CONNECT_MODE_DIRECT = 'CONNECT_MODE_DIRECT';
export const CONNECT_MODE_CARD = 'CONNECT_MODE_CARD';

export type ReaderConnectMode = typeof CONNECT_MODE_DIRECT | typeof CONNECT_MODE_CARD;

export type ReaderConnection = {
	type: number;
	protocol: number;
}

export type Card = {
	atr?: Buffer;
	standard?: "TAG_ISO_14443_3" | "TAG_ISO_14443_4";
	type?: string;
	uid?: string;
	data?: Buffer;
}

interface Reader {
	on(type: "card", listener: (card: Card) => void): this;
	once(type: "card", listener: (card: Card) => void): this;
	on(type: "card.off", listener: (card: Card) => void): this;
	once(type: "card.off", listener: (card: Card) => void): this;
	on(type: "error", listener: (error: any) => void): this;
	once(type: "error", listener: (error: any) => void): this;
	on(type: "end", listener: () => void): this;
	once(type: "end", listener: () => void): this;
}

class Reader extends EventEmitter {

	connection: ReaderConnection | null = null;
	card: Card | null = null;

	autoProcessing = true;
	_aid: ((card: Card) => any) | Buffer | string | null = null;

	keyStorage: { [keyNumber: number]: Buffer | null } = {
		0: null,
		1: null,
	};

	/** Keys that are (by their actual string representation) waiting to be loaded */
	pendingLoadAuthenticationKey: {[ keyHex: string ]: ReturnType<Reader['loadAuthenticationKey']> } = {};

	/**
	 * Reverses a copy of a given buffer
	 * Does NOT mutate the given buffer, returns a reversed COPY
	 * For mutating reverse use native .reverse() method on a buffer instance
	 */
	static reverseBuffer(src: Buffer): Buffer {

		const buffer = Buffer.allocUnsafe(src.length);

		for (let i = 0, j = src.length - 1; i <= j; ++i, --j) {
			buffer[i] = src[j];
			buffer[j] = src[i];
		}

		return buffer;

	}

	static selectStandardByAtr(atr: Buffer) {

		// TODO: better detecting card types
		if (atr[5] && atr[5] === 0x4f) {
			return TAG_ISO_14443_3;
		}
		else {
			return TAG_ISO_14443_4;
		}

	}

	get aid() {
		return this._aid;
	}

	set aid(value: Reader['_aid']) {

		if (typeof value === 'function' || Buffer.isBuffer(value)) {
			this._aid = value;
			return;
		}

		if (typeof value !== 'string') {
			throw new Error(`AID must be a HEX string or an instance of Buffer or a function.`);
		}

		this._aid = Buffer.from(value, 'hex');

	}

	/** E.g. `"HID OMNIKEY 5427CK"` */
	get name() {
		return this.reader.name;
	}

	constructor(
		/** PCSCLite CardReader instance used internally for read/write/connection operations */
		public reader: CardReader, 
		/** Logger class */
		public logger: Pick<Console, 'log' | 'debug' | 'info' | 'warn' | 'error'>,
	) {
		super();

		this.reader.on('error', (err) => {

			this.logger.error(err);

			this.emit('error', err);

		});

		this.reader.on('status', async status => {

			this.logger.debug('status', status);

			// check what has changed
			const changes = this.reader.state ^ status.state;

			this.logger.debug('changes', changes);

			if (changes) {

				if ((changes & this.reader.SCARD_STATE_EMPTY) && (status.state & this.reader.SCARD_STATE_EMPTY)) {

					this.logger.debug('card removed');

					if (this.card) {
						this.emit('card.off', { ...this.card });
					}

					try {

						this.card = null;
						if (this.connection) {
							await this.disconnect();
						}

					} catch (err) {

						this.emit(err);

					}

				}
				else if ((changes & this.reader.SCARD_STATE_PRESENT) && (status.state & this.reader.SCARD_STATE_PRESENT)) {

					const atr = status.atr;

					this.logger.debug('card inserted', atr);

					this.card = {};

					if (atr) {
						this.card.atr = atr;
						this.card.standard = Reader.selectStandardByAtr(atr);
						this.card.type = this.card.standard;
					}

					try {

						await this.connect();

						if (!this.autoProcessing) {
							this.emit('card', { ...this.card });
							return;
						}

						this.handleTag();

					} catch (err) {

						this.emit(err);

					}


				}
			}
		});

		this.reader.on('end', () => {

			this.logger.debug('reader removed');

			this.emit('end');

		});

	}

	/**
	 * @param protocol Either T=0 or T=1 defined as {@link CardReader.SCARD_PROTOCOL_T0} or
	 * {@link CardReader.SCARD_PROTOCOL_T1}. If connecting in direct mode when no card is present
	 * this must be {@link CardReader.SCARD_PROTOCOL_T0}. Default behaviour is to use
	 * this.SCARD_PROTOCOL_T0 | this.SCARD_PROTOCOL_T1 if not defined (not sure how this works maybe automatic..?)
	 */
	connect(mode: ReaderConnectMode = CONNECT_MODE_CARD, protocol?: CardReader['SCARD_PROTOCOL_T0'] | CardReader['SCARD_PROTOCOL_T1']) {

		// console.log(`Connect to ${this.name} in mode ${mode} with protocol ${protocol}`);

		const modes = {
			[CONNECT_MODE_DIRECT]: this.reader.SCARD_SHARE_DIRECT,
			[CONNECT_MODE_CARD]: this.reader.SCARD_SHARE_SHARED,
		};

		if (!modes[mode]) {
			throw new ConnectError('invalid_mode', 'Invalid mode')
		}

		this.logger.debug('trying to connect', mode, modes[mode]);

		return new Promise((resolve, reject) => {

			// connect card
			this.reader.connect({
				share_mode: modes[mode],
				...protocol != undefined ? { protocol } : {}
			}, (err, connectionProtocol) => {

				// console.log(`Connected to ${this.name} in mode ${mode} with protocol ${connectionProtocol}`);

				if (err) {
					const error = new ConnectError(FAILURE, 'An error occurred while connecting.', err);
					this.logger.error(error);
					return reject(error);
				}

				this.connection = {
					type: modes[mode],
					protocol: connectionProtocol || 0,
				};

				this.logger.debug('connected', this.connection);

				return resolve(this.connection);

			});

		});

	}

	disconnect() {

		if (!this.connection) {
			throw new DisconnectError('not_connected', 'Reader in not connected. No need for disconnecting.')
		}

		this.logger.debug('trying to disconnect', this.connection);

		return new Promise((resolve, reject) => {

			// disconnect removed
			this.reader.disconnect(this.reader.SCARD_LEAVE_CARD, (err) => {

				if (err) {
					const error = new DisconnectError(FAILURE, 'An error occurred while disconnecting.', err);
					this.logger.error(error);
					return reject(error);
				}

				this.connection = null;

				this.logger.debug('disconnected');

				return resolve(true);

			});

		});

	}

	transmit(data: Buffer, responseMaxLength: number): Promise<Buffer> {

		if (!this.card) {
			throw new TransmitError(CARD_NOT_CONNECTED, 'No card');
		}

		const calledFrom = new Error()

		return new Promise((resolve, reject) => {

			this.logger.debug('transmitting', data, responseMaxLength);

			if (!this.connection) {
				return reject(new TransmitError(CARD_NOT_CONNECTED, 'No card or connection available.'))
			}

			this.reader.transmit(data, responseMaxLength, this.connection.protocol, (err, response) => {

				if (err) {
					const error = new TransmitError(FAILURE, 'An error occurred while transmitting.', err);
					console.log(`Rejecting promise returned by pcsc transmit with err`, err, `Originally called from`, calledFrom.stack);
					return reject(error);
				}

				this.logger.debug('transmit response received', response, response && response.length);

				return resolve(response);

			});

		});

	}

	control(data: Buffer, responseMaxLength: number): Promise<Buffer> {

		if (!this.connection) {
			throw new ControlError('not_connected', 'No connection available.');
		}

		return new Promise((resolve, reject) => {

			this.logger.debug('transmitting control', data, responseMaxLength);

			// CORRECT IOCTL_CCID_ESCAPE for each platform. @pokusew\pcsclite\src\cardreader.h has
			// wrong definition for WIN32. For some reason (driver differences?) the constants are
			// completely different between platforms.
			const IOCTL_CCID_ESCAPE = /^win/.test(process.platform)
				? this.reader.SCARD_CTL_CODE(3500)  // (0x31 << 16 | 3500 << 2) = 0x3136B0
				: this.reader.SCARD_CTL_CODE(1)  // 0x42000000 + 1

			this.reader.control(data, IOCTL_CCID_ESCAPE, responseMaxLength, (err, response) => {

				if (err) {
					const error = new ControlError(FAILURE, 'An error occurred while transmitting control.', err);
					return reject(error);
				}

				this.logger.debug('control response received', response, response && response.length);

				return resolve(response);

			});

		});

	}

	async loadAuthenticationKey(keyNumber: number, key: string | Buffer | number[]) {

		if (!(keyNumber === 0 || keyNumber === 1)) {
			throw new LoadAuthenticationKeyError('invalid_key_number');
		}

		if (!Buffer.isBuffer(key) && !Array.isArray(key)) {

			if (typeof key !== 'string') {
				throw new LoadAuthenticationKeyError(
					'invalid_key',
					'Key must an instance of Buffer or an array of bytes or a string.',
				);
			}

			key = Buffer.from(key, 'hex');

		}

		if (key.length !== 6) {
			throw new LoadAuthenticationKeyError('invalid_key', 'Key length must be 6 bytes.');
		}

		// CMD: Load Authentication Keys
		const packet = Buffer.from([
			0xff, // Class
			0x82, // INS
			0x00, // P1: Key Structure (0x00 = Key is loaded into the reader volatile memory.)
			keyNumber, // P2: Key Number (00h ~ 01h = Key Location. The keys will disappear once the reader is disconnected from the PC)
			key.length, // Lc: Length of the key (6)
			...key, // Data In: Key (6 bytes)
		]);

		try {

			var response = await this.transmit(packet, 2);

		} catch (err) {

			throw new LoadAuthenticationKeyError(null, null, err);

		}

		const statusCode = response.readUInt16BE(0);

		if (statusCode !== 0x9000) {
			throw new LoadAuthenticationKeyError(OPERATION_FAILED, `Load authentication key operation failed: Status code: ${statusCode}`);
		}

		console.log(`loaded key, setting this.keyStorage[${keyNumber}] = ${key}`)
		this.keyStorage[keyNumber] = key as Buffer;

		return keyNumber;

	}

	/** Key `null` will be passed when the caller wants to know if there is an UNUSED key slot */
	findKeyNumber(key: string | null): number | undefined {
		const keyNumber = Object.keys(this.keyStorage).find(k => {
			const keyVal = this.keyStorage[+k]
			if (key === null)
				return keyVal === null
			else
				return keyVal?.toString('hex').toLowerCase() === key.toLowerCase()
		})
		return keyNumber === undefined ? undefined : +keyNumber
	}

	// for PC/SC V2.01 use obsolete = true
	// for PC/SC V2.07 use obsolete = false [default]
	/**
	 * @param blockNumber The block on the mifare card to authenticate to
	 * @param keyType One of the exported KEY_TYPE_A or KEY_TYPE_B
	 * @param key The key as a hex string
	 */
	async authenticate(blockNumber: number, keyType: typeof KEY_TYPE_A | typeof KEY_TYPE_B, key: string, obsolete = false) {
		let keyNumber = this.findKeyNumber(key)

		console.log(`Result finding key ${key} in keyStorage: keyNumber = ${keyNumber}`)

		// key is not in the storage
		if (keyNumber === undefined) {

			// If there isn't already an authentication process happening for this key, start it
			if (!this.pendingLoadAuthenticationKey[key]) {

				// set key number to first
				keyNumber = +Object.keys(this.keyStorage)[0];

				// if this number is not free
				if (this.keyStorage[keyNumber] !== null) {
					// try to find any free number
					const freeNumber = this.findKeyNumber(null)
					// if we find, we use it, otherwise the first will be used and rewritten
					if (freeNumber) {
						keyNumber = +freeNumber;
					}
				}

				// Store the authentication promise in case other blocks are in process of authentication
				this.pendingLoadAuthenticationKey[key] = this.loadAuthenticationKey(keyNumber, key);

			}

			try {
				keyNumber = await this.pendingLoadAuthenticationKey[key];
			} catch (err) {
				throw new AuthenticationError('unable_to_load_key', 'Could not load authentication key into reader.', err);
			} finally {
				// remove the loadAuthenticationKey Promise from pendingLoadAuthenticationKey
				// as it is already resolved or rejected at this point
				delete this.pendingLoadAuthenticationKey[key];
			}

		}

		const packet = !obsolete ? (
			// CMD: Authentication
			Buffer.from([
				0xff, // Class
				0x86, // INS
				0x00, // P1
				0x00, // P2
				0x05, // Lc
				// Data In: Authenticate Data Bytes (5 bytes)
				0x01, // Byte 1: Version
				0x00, // Byte 2
				blockNumber, // Byte 3: Block Number
				keyType, // Byte 4: Key Type
				keyNumber, // Byte 5: Key Number
			])
		) : (
			// CMD: Authentication (obsolete)
			Buffer.from([
				0xff, // Class
				0x88, // INS
				0x00, // P1
				blockNumber, // P2: Block Number
				keyType, // P3: Key Type
				keyNumber, // Data In: Key Number
			])
		);

		let response = null;

		try {

			response = await this.transmit(packet, 2);

		} catch (err) {

			throw new AuthenticationError(null, null, err);

		}

		const statusCode = response.readUInt16BE(0);

		if (statusCode !== 0x9000) {
			this.logger.error('[authentication operation failed][request packet]', packet);
			throw new AuthenticationError(OPERATION_FAILED, `Authentication operation failed: Status code: 0x${statusCode.toString(16)}`);
		}

		return true;

	}

	async read(blockNumber: number, length: number, blockSize = 4, packetSize = 16, readClass = 0xff) {

		if (!this.card) {
			throw new ReadError(CARD_NOT_CONNECTED);
		}

		this.logger.debug('reading data from card', this.card);

		if (length > packetSize) {

			const p = Math.ceil(length / packetSize);

			const commands: Promise<Buffer>[] = [];

			for (let i = 0; i < p; i++) {

				const block = blockNumber + ((i * packetSize) / blockSize);

				const size = ((i + 1) * packetSize) < length ? packetSize : length - ((i) * packetSize);

				// console.log(i, block, size);

				commands.push(this.read(block, size, blockSize, packetSize, readClass));

			}

			return Promise.all(commands).then(values => Buffer.concat(values, length))

		}

		// APDU CMD: Read Binary Blocks
		const packet = Buffer.from([
			readClass, // Class
			0xb0, // Ins
			(blockNumber >> 8) & 0xFF, // P1
			blockNumber & 0xFF, // P2: Block Number
			length,  // Le: Number of Bytes to Read (Maximum 16 bytes)
		]);

		let response = null;

		try {

			response = await this.transmit(packet, length + 2);

		} catch (err) {

			throw new ReadError(null, null, err);

		}

		if (response.length < 2) {
			throw new ReadError(OPERATION_FAILED, `Read operation failed: Invalid response length ${response.length}. Expected minimal length is 2 bytes.`);
		}

		const statusCode = response.slice(-2).readUInt16BE(0);

		if (statusCode !== 0x9000) {
			throw new ReadError(OPERATION_FAILED, `Read operation failed: Status code: 0x${statusCode.toString(16)}`);
		}

		const data = response.slice(0, -2);

		this.logger.debug('data', data);

		return data;

	}

	async write(blockNumber: number, data: Buffer, blockSize = 4) {

		if (!this.card) {
			throw new WriteError(CARD_NOT_CONNECTED);
		}

		this.logger.debug('writing data to card', this.card);

		if (data.length < blockSize || data.length % blockSize !== 0) {
			throw new WriteError('invalid_data_length', 'Invalid data length. You can only update the entire data block(s).');
		}

		if (data.length > blockSize) {

			const p = data.length / blockSize;

			const commands: Promise<boolean>[] = [];

			for (let i = 0; i < p; i++) {

				const block = blockNumber + i;

				const start = i * blockSize;
				const end = (i + 1) * blockSize;

				const part = data.slice(start, end);

				// console.log(i, block, start, end, part);

				commands.push(this.write(block, part, blockSize));

			}

			return Promise.all(commands).then(() => true)

		}

		// APDU CMD: Update Binary Block
		const packetHeader = Buffer.from([
			0xff, // Class
			0xd6, // Ins
			0x00, // P1
			blockNumber, // P2: Block Number
			blockSize, // Le: Number of Bytes to Update
		]);

		const packet = Buffer.concat([packetHeader, data]);

		let response = null;

		try {

			response = await this.transmit(packet, 2);

		} catch (err) {

			throw new WriteError(null, null, err);

		}

		if (response.length < 2) {
			throw new WriteError(OPERATION_FAILED, `Write operation failed: Invalid response length ${response.length}. Expected minimal length is 2 bytes.`);
		}

		const statusCode = response.slice(-2).readUInt16BE(0);

		if (statusCode !== 0x9000) {
			throw new WriteError(OPERATION_FAILED, `Write operation failed: Status code: 0x${statusCode.toString(16)}`);
		}

		return true;

	}

	handleTag() {

		if (!this.card) {
			return false;
		}

		this.logger.debug('handling tag', this.card);

		switch (this.card.standard) {

			case TAG_ISO_14443_3:
				return this.handle_Iso_14443_3_Tag();

			case TAG_ISO_14443_4:
				return this.handle_Iso_14443_4_Tag();

			default:
				return this.handle_Iso_14443_3_Tag();

		}

	}

	// TODO: improve error handling and debugging
	async handle_Iso_14443_3_Tag() {

		if (!this.card || !this.connection) {
			return false;
		}

		this.logger.debug('processing ISO 14443-3 tag', this.card);

		// APDU CMD: Get Data
		const packet = Buffer.from([
			0xff, // Class
			0xca, // INS
			0x00, // P1: Get current card UID
			0x00, // P2
			0x00, // Le: Full Length of UID
		]);

		try {

			const response = await this.transmit(packet, 12);

			if (response.length < 2) {

				const error = new GetUIDError('invalid_response', `Invalid response length ${response.length}. Expected minimal length is 2 bytes.`);
				this.emit('error', error);

				return;

			}

			// last 2 bytes are the status code
			const statusCode = response.slice(-2).readUInt16BE(0);

			// an error occurred
			if (statusCode !== 0x9000) {

				const error = new GetUIDError(OPERATION_FAILED, 'Could not get card UID.');
				this.emit('error', error);

				return;
			}

			// strip out the status code (the rest is UID)
			const uid = response.slice(0, -2).toString('hex');
			// const uidReverse = Reader.reverseBuffer(response.slice(0, -2)).toString('hex');

			this.card.uid = uid;

			this.emit('card', { ...this.card });


		} catch (err) {

			const error = new GetUIDError(null, null, err);

			this.emit('error', error);

		}

	}

	// TODO: improve error handling and debugging
	async handle_Iso_14443_4_Tag() {

		if (!this.card || !this.connection) {
			return false;
		}

		this.logger.debug('processing ISO 14443-4 tag', this.card);

		if (!this.aid) {
			this.emit('error', new Error('Cannot process ISO 14443-4 tag because AID was not set.'));
			return;
		}

		const aid = typeof this.aid === 'function' ? this.aid(this.card) : this.aid;

		if (!Buffer.isBuffer(aid)) {
			this.emit('error', new Error('AID must be an instance of Buffer.'));
			return;
		}

		// APDU CMD: SELECT FILE
		// see http://cardwerk.com/smart-card-standard-iso7816-4-section-6-basic-interindustry-commands/#chap6_11_3
		const packet = Buffer.from([
			0x00, // Class
			0xa4, // INS
			0x04, // P1
			0x00, // P2
			aid.length, // Lc
			...aid, // AID
			0x00, // Le
		]);

		try {

			const response = await this.transmit(packet, 40);

			if (response.length === 2 && response.readUInt16BE(0) === 0x6a82) {

				const err = new Error(`Not found response. Tag not compatible with AID ${aid.toString('hex').toUpperCase()}.`);
				this.emit('error', err);

				return;
			}

			if (response.length < 2) {

				const err = new Error(`Invalid response length ${response.length}. Expected minimal length is 2 bytes.`);
				this.emit('error', err);

				return;
			}

			// another possibility const statusCode = parseInt(response.slice(-2).toString('hex'), 16)
			const statusCode = response.slice(-2).readUInt16BE(0);

			// an error occurred
			if (statusCode !== 0x9000) {

				const err = new Error(`Response status error.`);
				this.emit('error', err);

				return;
			}

			// strip out the status code
			const data = response.slice(0, -2);

			this.logger.debug('Data cropped', data);

			this.emit('card', {
				...this.card,
				data: data,
			});

		} catch (err) {

			const error = new GetUIDError(null, null, err);

			this.emit('error', error);

		}

	}

	close() {
		this.reader.close();
	}

	toString() {
		return this.name;
	}

}

export default Reader;
