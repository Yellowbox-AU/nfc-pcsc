"use strict";

import pcsclite from '@pokusew/pcsclite';
import EventEmitter from 'events';
import Reader from './Reader';
import ACR122Reader from './ACR122Reader';

/** Exposed PCSCLite type from @pokusew/pcsclite */
export type PCSCLite = ReturnType<typeof pcsclite> & {
	readers: { [name: string]: CardReader }
}

/** Exposed CardReader type from @pokusew/pcsclite */
export type CardReader = Parameters<Parameters<PCSCLite['on']>[1]>[0] & {
	/**
	 * ### Warning: On WIN32 this definition (from @pokusew\pcsclite\src\cardreader.h) as `0x42000000 + 3500` is incorrect and should be `(0x31 << 16 | 3500 << 2)`
	 * **Instead use `CardReader.SCARD_CTL_CODE(3500)` on windows and `CardReader.SCARD_CTL_CODE(1)` on *nix to get the correct constant**
	 *
	 * Often reader’s peripherals control commands (e.g. controlling buzzer functionality) are
	 * implemented by using the IOCTL_CCID_ESCAPE control code. Note: For ACS readers the driver
	 * will add the Class, INS and P1 automatically (may apply to other readers too)
	 */
	IOCTL_CCID_ESCAPE: number
}

const noopLogFn: (...args: any) => void = () => {}
const noopLogger = {
	log: noopLogFn,
	debug: noopLogFn,
	info: noopLogFn,
	warn: noopLogFn,
	error: noopLogFn,
}
interface NFC {
	on(type: "reader", listener: (reader: Reader | ACR122Reader) => void): this;
	once(type: "reader", listener: (reader: Reader | ACR122Reader) => void): this;
	on(type: "error", listener: (error: any) => void): this;
	once(type: "error", listener: (error: any) => void): this;
}

class NFC extends EventEmitter {
	constructor(
		/** Logger class */
		private logger = noopLogger,
		/** The internal pcsc instance used for communication with the reader */
		public pcsc = pcsclite() as PCSCLite
	) {
		super();

		this.pcsc.on('reader', (reader) => {

			this.logger.debug('new reader detected', reader.name);

			// create special object for ARC122U reader with commands specific to this reader
			if (

				// 'acr122' matches ARC122U
				reader.name.toLowerCase().indexOf('acr122') !== -1

				// 'acr125' matches ACR1252U reader because ACR1252U has some common commands with ARC122U
				//   ACR1252U product page: https://www.acs.com.hk/en/products/342/acr1252u-usb-nfc-reader-iii-nfc-forum-certified-reader/
				//   TODO: in the future, this should be refactored:
				//         see discussion in PR#111 https://github.com/pokusew/nfc-pcsc/pull/111
				|| reader.name.toLowerCase().indexOf('acr125') !== -1

			) {

				const device = new ACR122Reader(reader as CardReader, this.logger);

				this.emit('reader', device);

				return;

			}

			const device = new Reader(reader as CardReader, this.logger);

			this.emit('reader', device);

		});

		this.pcsc.on('error', (err) => {

			this.logger.error('PCSC error', err.message);

			this.emit('error', err);

		});

	}

	get readers() {
		return this.pcsc.readers;
	}

	close() {
		this.pcsc.close();
	}

}

export default NFC;
