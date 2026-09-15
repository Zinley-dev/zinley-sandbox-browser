/**
 * Gmail API Service for Browser Use
 * Handles Gmail API authentication, email reading, and 2FA code extraction.
 * Port from browser_use/integrations/gmail/service.py
 */

import * as fs from 'fs';
import * as path from 'path';
import { getConfig } from '../../config.js';

// Try to import googleapis
let google: any;
let OAuth2Client: any;
try {
	const googleapis = require('googleapis');
	google = googleapis.google;
	const { OAuth2Client: OAuth2 } = require('google-auth-library');
	OAuth2Client = OAuth2;
} catch {
	// googleapis not available
}

/**
 * Gmail message structure
 */
export interface GmailMessage {
	id: string;
	threadId: string;
	subject: string;
	from: string;
	to: string;
	date: string;
	timestamp: number;
	body: string;
	rawMessage: any;
}

/**
 * Gmail Service options
 */
export interface GmailServiceOptions {
	credentialsFile?: string;
	tokenFile?: string;
	configDir?: string;
	accessToken?: string;
}

/**
 * Gmail API service for email reading.
 * Provides functionality to:
 * - Authenticate with Gmail API using OAuth2
 * - Read recent emails with filtering
 * - Return full email content for agent analysis
 */
export class GmailService {
	// Gmail API scopes
	private static readonly SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

	private configDir: string;
	private credentialsFile: string;
	private tokenFile: string;
	private accessToken: string | null;
	private service: any = null;
	private creds: any = null;
	private _authenticated: boolean = false;

	constructor(options: GmailServiceOptions = {}) {
		const config = getConfig();

		// Set up configuration directory
		this.configDir = options.configDir || config.BROWSER_USE_CONFIG_DIR;

		// Ensure config directory exists (only if not using direct token)
		if (!options.accessToken) {
			fs.mkdirSync(this.configDir, { recursive: true });
		}

		// Set up credential paths
		this.credentialsFile = options.credentialsFile || path.join(this.configDir, 'gmail_credentials.json');
		this.tokenFile = options.tokenFile || path.join(this.configDir, 'gmail_token.json');

		// Direct access token support
		this.accessToken = options.accessToken || null;
	}

	/**
	 * Check if Gmail service is authenticated
	 */
	isAuthenticated(): boolean {
		return this._authenticated && this.service !== null;
	}

	/**
	 * Handle OAuth authentication and token management
	 * @returns True if authentication successful, False otherwise
	 */
	async authenticate(): Promise<boolean> {
		if (!google || !OAuth2Client) {
			console.error('❌ googleapis package not installed. Run: npm install googleapis google-auth-library');
			return false;
		}

		try {
			console.log('🔐 Authenticating with Gmail API...');

			// Check if using direct access token
			if (this.accessToken) {
				console.log('🔑 Using provided access token');
				// Create OAuth2 client with access token
				const oauth2Client = new OAuth2Client();
				oauth2Client.setCredentials({ access_token: this.accessToken });
				this.creds = oauth2Client;
				// Build Gmail service
				this.service = google.gmail({ version: 'v1', auth: oauth2Client });
				this._authenticated = true;
				console.log('✅ Gmail API ready with access token!');
				return true;
			}

			// Original file-based authentication flow
			let oauth2Client: any;

			// Try to load existing tokens
			if (fs.existsSync(this.tokenFile)) {
				const tokenData = JSON.parse(fs.readFileSync(this.tokenFile, 'utf-8'));

				// Load credentials file to get client ID/secret
				if (!fs.existsSync(this.credentialsFile)) {
					console.error(
						`❌ Gmail credentials file not found: ${this.credentialsFile}\n` +
						'Please download it from Google Cloud Console:\n' +
						'1. Go to https://console.cloud.google.com/\n' +
						'2. APIs & Services > Credentials\n' +
						'3. Download OAuth 2.0 Client JSON\n' +
						`4. Save as 'gmail_credentials.json' in ${this.configDir}/`
					);
					return false;
				}

				const credentials = JSON.parse(fs.readFileSync(this.credentialsFile, 'utf-8'));
				const { client_id, client_secret, redirect_uris } = credentials.installed || credentials.web;

				oauth2Client = new OAuth2Client(client_id, client_secret, redirect_uris?.[0]);
				oauth2Client.setCredentials(tokenData);
				this.creds = oauth2Client;

				console.debug('📁 Loaded existing tokens');

				// Check if token needs refresh
				if (tokenData.expiry_date && Date.now() >= tokenData.expiry_date) {
					console.log('🔄 Refreshing expired tokens...');
					try {
						const { credentials: refreshedCreds } = await oauth2Client.refreshAccessToken();
						oauth2Client.setCredentials(refreshedCreds);
						// Save refreshed tokens
						fs.writeFileSync(this.tokenFile, JSON.stringify(refreshedCreds));
						console.log(`💾 Tokens saved to ${this.tokenFile}`);
					} catch (refreshError: any) {
						console.warn('⚠️ Token refresh failed, will need re-authentication');
						// Clear invalid tokens
						fs.unlinkSync(this.tokenFile);
						return this.authenticate();
					}
				}
			} else {
				// Need to run OAuth flow
				console.log('🌐 Starting OAuth flow...');

				if (!fs.existsSync(this.credentialsFile)) {
					console.error(
						`❌ Gmail credentials file not found: ${this.credentialsFile}\n` +
						'Please download it from Google Cloud Console:\n' +
						'1. Go to https://console.cloud.google.com/\n' +
						'2. APIs & Services > Credentials\n' +
						'3. Download OAuth 2.0 Client JSON\n' +
						`4. Save as 'gmail_credentials.json' in ${this.configDir}/`
					);
					return false;
				}

				const credentials = JSON.parse(fs.readFileSync(this.credentialsFile, 'utf-8'));
				const { client_id, client_secret, redirect_uris } = credentials.installed || credentials.web;

				oauth2Client = new OAuth2Client(client_id, client_secret, 'http://localhost:8080');

				// Generate auth URL
				const authUrl = oauth2Client.generateAuthUrl({
					access_type: 'offline',
					scope: GmailService.SCOPES,
				});

				console.log('Please visit this URL to authorize the application:');
				console.log(authUrl);
				console.log('\nWaiting for authorization...');

				// Start local server to receive callback
				const code = await this.waitForAuthCode(8080);
				if (!code) {
					console.error('❌ No authorization code received');
					return false;
				}

				// Exchange code for tokens
				const { tokens } = await oauth2Client.getToken(code);
				oauth2Client.setCredentials(tokens);
				this.creds = oauth2Client;

				// Save tokens for next time
				fs.writeFileSync(this.tokenFile, JSON.stringify(tokens));
				console.log(`💾 Tokens saved to ${this.tokenFile}`);
			}

			// Build Gmail service
			this.service = google.gmail({ version: 'v1', auth: oauth2Client });
			this._authenticated = true;
			console.log('✅ Gmail API ready!');
			return true;

		} catch (e: any) {
			console.error(`❌ Gmail authentication failed: ${e.message}`);
			return false;
		}
	}

	/**
	 * Wait for OAuth authorization code via local HTTP server
	 */
	private waitForAuthCode(port: number): Promise<string | null> {
		return new Promise((resolve) => {
			const http = require('http');
			const url = require('url');

			const server = http.createServer((req: any, res: any) => {
				const queryParams = url.parse(req.url, true).query;
				const code = queryParams.code;

				if (code) {
					res.writeHead(200, { 'Content-Type': 'text/html' });
					res.end('<html><body><h1>Authentication successful!</h1><p>You can close this window.</p></body></html>');
					server.close();
					resolve(code);
				} else {
					res.writeHead(400, { 'Content-Type': 'text/html' });
					res.end('<html><body><h1>Authentication failed</h1><p>No code received.</p></body></html>');
				}
			});

			server.listen(port, () => {
				// Open browser (try different methods)
				const open = require('child_process').exec;
				const authUrl = `Waiting for OAuth callback on http://localhost:${port}`;
				console.log(authUrl);
			});

			// Timeout after 5 minutes
			setTimeout(() => {
				server.close();
				resolve(null);
			}, 5 * 60 * 1000);
		});
	}

	/**
	 * Get recent emails with optional query filter
	 * @param maxResults Maximum number of emails to fetch
	 * @param query Gmail search query (e.g., 'from:noreply@example.com')
	 * @param timeFilter Time filter (e.g., '5m', '1h', '1d')
	 * @returns List of email dictionaries with parsed content
	 */
	async getRecentEmails(maxResults: number = 10, query: string = '', timeFilter: string = '1h'): Promise<GmailMessage[]> {
		if (!this.isAuthenticated()) {
			console.error('❌ Gmail service not authenticated. Call authenticate() first.');
			return [];
		}

		try {
			// Add time filter to query if provided
			let fullQuery = query;
			if (timeFilter && !query.includes('newer_than:')) {
				fullQuery = `newer_than:${timeFilter} ${query}`.trim();
			}

			console.log(`📧 Fetching ${maxResults} recent emails...`);
			if (fullQuery) {
				console.debug(`🔍 Query: ${fullQuery}`);
			}

			// Get message list
			const response = await this.service.users.messages.list({
				userId: 'me',
				maxResults,
				q: fullQuery,
			});

			const messages = response.data.messages || [];
			if (messages.length === 0) {
				console.log('📭 No messages found');
				return [];
			}

			console.log(`📨 Found ${messages.length} messages, fetching details...`);

			// Get full message details
			const emails: GmailMessage[] = [];
			for (let i = 0; i < messages.length; i++) {
				console.debug(`📖 Reading email ${i + 1}/${messages.length}...`);

				const fullMessage = await this.service.users.messages.get({
					userId: 'me',
					id: messages[i].id,
					format: 'full',
				});

				const emailData = this.parseEmail(fullMessage.data);
				emails.push(emailData);
			}

			return emails;
		} catch (error: any) {
			if (error.code) {
				console.error(`❌ Gmail API error: ${error.message}`);
			} else {
				console.error(`❌ Unexpected error fetching emails: ${error.message}`);
			}
			return [];
		}
	}

	/**
	 * Parse Gmail message into readable format
	 */
	private parseEmail(message: any): GmailMessage {
		const headers: Record<string, string> = {};
		for (const header of message.payload?.headers || []) {
			headers[header.name] = header.value;
		}

		return {
			id: message.id,
			threadId: message.threadId,
			subject: headers['Subject'] || '',
			from: headers['From'] || '',
			to: headers['To'] || '',
			date: headers['Date'] || '',
			timestamp: parseInt(message.internalDate, 10),
			body: this.extractBody(message.payload),
			rawMessage: message,
		};
	}

	/**
	 * Extract email body from payload
	 */
	private extractBody(payload: any): string {
		let body = '';

		if (payload?.body?.data) {
			// Simple email body
			body = Buffer.from(payload.body.data, 'base64url').toString('utf-8');
		} else if (payload?.parts) {
			// Multi-part email
			for (const part of payload.parts) {
				if (part.mimeType === 'text/plain' && part.body?.data) {
					const partBody = Buffer.from(part.body.data, 'base64url').toString('utf-8');
					body += partBody;
				} else if (part.mimeType === 'text/html' && !body && part.body?.data) {
					// Fallback to HTML if no plain text
					body = Buffer.from(part.body.data, 'base64url').toString('utf-8');
				}
			}
		}

		return body;
	}
}
