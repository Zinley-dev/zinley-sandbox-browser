/**
 * Logging configuration
 * Port from browser_use/logging_config.py
 *
 * Provides centralized logging configuration for browser-use.
 */

import winston from 'winston';
import { getConfig } from './config.js';

// Custom log levels including RESULT
const customLevels = {
	levels: {
		error: 0,
		warn: 1,
		result: 2,
		info: 3,
		debug: 4,
	},
	colors: {
		error: 'red',
		warn: 'yellow',
		result: 'green',
		info: 'blue',
		debug: 'gray',
	},
};

// Add custom colors
winston.addColors(customLevels.colors);

// Singleton logger instance
let _logger: winston.Logger | null = null;

/**
 * Custom formatter that cleans up logger names for non-debug modes
 */
function createBrowserUseFormat(logLevel: string) {
	return winston.format.printf(({ level, message, timestamp, ...meta }): string => {
		let name = meta.name || 'browser-use';
		const msg = String(message);

		// Only clean up names in INFO mode, keep everything in DEBUG mode
		if (logLevel !== 'debug' && typeof name === 'string' && name.startsWith('browser-use.')) {
			if (name.includes('Agent')) {
				name = 'Agent';
			} else if (name.includes('BrowserSession')) {
				name = 'BrowserSession';
			} else if (name.includes('tools')) {
				name = 'tools';
			} else if (name.includes('dom')) {
				name = 'dom';
			} else {
				const parts = name.split('.');
				if (parts.length >= 2) {
					name = parts[parts.length - 1];
				}
			}
		}

		if (logLevel === 'result') {
			return msg;
		}

		return `${level.toUpperCase().padEnd(8)} [${name}] ${msg}`;
	});
}

/**
 * Setup logging configuration for browser-use.
 *
 * @param options Configuration options
 * @returns Configured logger instance
 */
export function setupLogging(options: {
	stream?: NodeJS.WriteStream;
	logLevel?: string;
	forceSetup?: boolean;
	debugLogFile?: string;
	infoLogFile?: string;
} = {}): winston.Logger {
	const config = getConfig();
	const logType = options.logLevel || config.BROWSER_USE_LOGGING_LEVEL;

	// If logger exists and not forcing, return existing
	if (_logger && !options.forceSetup) {
		return _logger;
	}

	// Determine log level
	let level: string;
	if (logType === 'result') {
		level = 'result';
	} else if (logType === 'debug') {
		level = 'debug';
	} else {
		level = 'info';
	}

	// Build transports
	const transports: winston.transport[] = [];

	// Console transport
	transports.push(
		new winston.transports.Console({
			level,
			format: winston.format.combine(
				winston.format.colorize(),
				createBrowserUseFormat(logType)
			),
		})
	);

	// Debug log file transport
	if (options.debugLogFile) {
		transports.push(
			new winston.transports.File({
				filename: options.debugLogFile,
				level: 'debug',
				format: winston.format.combine(
					winston.format.timestamp(),
					createBrowserUseFormat('debug')
				),
			})
		);
	}

	// Info log file transport
	if (options.infoLogFile) {
		transports.push(
			new winston.transports.File({
				filename: options.infoLogFile,
				level: 'info',
				format: winston.format.combine(
					winston.format.timestamp(),
					createBrowserUseFormat('info')
				),
			})
		);
	}

	// Create logger
	_logger = winston.createLogger({
		levels: customLevels.levels,
		level: options.debugLogFile ? 'debug' : level,
		transports,
	});

	return _logger;
}

/**
 * Configure logging (alias for setupLogging)
 */
export function configureLogging(level: string = 'info'): winston.Logger {
	return setupLogging({ logLevel: level });
}

/**
 * Get the current logger instance
 */
export function getLogger(name?: string): winston.Logger {
	if (!_logger) {
		_logger = setupLogging();
	}

	// If name provided, create a child logger with that name
	if (name) {
		return _logger.child({ name });
	}

	return _logger;
}

// Default export
export const logger = getLogger('browser-use');

/**
 * Silence third-party loggers
 * In Node.js, we typically silence them by not creating transports for them
 * This list is for reference of what we'd suppress in Python
 */
export const SILENCED_LOGGERS = [
	'httpx',
	'playwright',
	'urllib3',
	'asyncio',
	'langsmith',
	'openai',
	'httpcore',
	'anthropic',
	'groq',
	'google_genai',
];
