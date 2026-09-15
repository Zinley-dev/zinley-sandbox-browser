/**
 * Global configuration
 * Port from browser_use/config.py
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';

// ============================================================================
// Docker Detection (from Python is_running_in_docker())
// ============================================================================

let _dockerDetectionCache: boolean | null = null;

/**
 * Detect if we are running in a docker container.
 * Used for optimizing Chrome launch flags (dev shm usage, gpu settings, etc.)
 * Port from browser_use/config.py is_running_in_docker()
 */
export function isRunningInDocker(): boolean {
	// Return cached result if available
	if (_dockerDetectionCache !== null) {
		return _dockerDetectionCache;
	}

	// Check for /.dockerenv file
	try {
		if (fs.existsSync('/.dockerenv')) {
			_dockerDetectionCache = true;
			return true;
		}
	} catch {
		// Ignore errors
	}

	// Check /proc/1/cgroup for 'docker'
	try {
		const cgroupContent = fs.readFileSync('/proc/1/cgroup', 'utf-8');
		if (cgroupContent.toLowerCase().includes('docker')) {
			_dockerDetectionCache = true;
			return true;
		}
	} catch {
		// Ignore errors (file doesn't exist on non-Linux)
	}

	// Check if init process (PID 1) looks like a container init
	// On Linux, we can check /proc/1/cmdline
	try {
		const cmdline = fs.readFileSync('/proc/1/cmdline', 'utf-8').replace(/\0/g, ' ');
		// If PID 1 is node/python/uv/app, we're likely in a container
		if (/\b(node|python|py|uv|app)\b/i.test(cmdline)) {
			_dockerDetectionCache = true;
			return true;
		}
	} catch {
		// Ignore errors
	}

	// Check if very few processes are running (common in containers)
	try {
		// On Linux, count entries in /proc that are numeric (PIDs)
		const procEntries = fs.readdirSync('/proc');
		const pidCount = procEntries.filter((entry) => /^\d+$/.test(entry)).length;
		if (pidCount < 10) {
			_dockerDetectionCache = true;
			return true;
		}
	} catch {
		// Ignore errors
	}

	_dockerDetectionCache = false;
	return false;
}

/**
 * Configuration interface
 */
export interface BrowserUseConfig {
	version: string;
	defaultTimeout: number;
	maxRetries: number;

	// Logging
	BROWSER_USE_LOGGING_LEVEL: string;
	CDP_LOGGING_LEVEL: string;
	BROWSER_USE_DEBUG_LOG_FILE: string | null;
	BROWSER_USE_INFO_LOG_FILE: string | null;

	// Telemetry & Cloud
	ANONYMIZED_TELEMETRY: boolean;
	BROWSER_USE_CLOUD_SYNC: boolean;
	BROWSER_USE_CLOUD_API_URL: string;
	BROWSER_USE_CLOUD_UI_URL: string;
	/** Optional custom LiteLLM-style model pricing JSON URL */
	BROWSER_USE_MODEL_PRICING_URL: string;

	// Paths
	XDG_CACHE_HOME: string;
	XDG_CONFIG_HOME: string;
	BROWSER_USE_CONFIG_DIR: string;
	BROWSER_USE_CONFIG_FILE: string;
	BROWSER_USE_CONFIG_PATH: string | null;
	BROWSER_USE_PROFILES_DIR: string;
	BROWSER_USE_DEFAULT_USER_DATA_DIR: string;
	BROWSER_USE_EXTENSIONS_DIR: string;

	// API Keys (from environment)
	OPENAI_API_KEY: string;
	ANTHROPIC_API_KEY: string;
	GOOGLE_API_KEY: string;
	DEEPSEEK_API_KEY: string;
	GROK_API_KEY: string;
	NOVITA_API_KEY: string;
	AZURE_OPENAI_ENDPOINT: string;
	AZURE_OPENAI_KEY: string;
	SKIP_LLM_API_KEY_VERIFICATION: boolean;
	DEFAULT_LLM: string;

	// Runtime hints
	IN_DOCKER: boolean;
	IS_IN_EVALS: boolean;
	WIN_FONT_DIR: string;
	/** Check npm for a newer browser-use version at startup (default true) */
	BROWSER_USE_VERSION_CHECK: boolean;
	/** Disable the default browser extensions (null = unset) */
	BROWSER_USE_DISABLE_EXTENSIONS: boolean | null;
}

// ============================================================================
// DB-Style Config Types (for config.json)
// ============================================================================

export interface DBStyleEntry {
	id: string;
	default: boolean;
	created_at: string;
}

export interface BrowserProfileEntry extends DBStyleEntry {
	headless?: boolean;
	user_data_dir?: string;
	allowed_domains?: string[];
	downloads_path?: string;
	keep_alive?: boolean;
	wait_between_actions?: number;
	device_scale_factor?: number;
	disable_security?: boolean;
	[key: string]: any;
}

export interface LLMEntry extends DBStyleEntry {
	api_key?: string;
	model?: string;
	temperature?: number;
	max_tokens?: number;
}

export interface AgentEntry extends DBStyleEntry {
	max_steps?: number;
	use_vision?: boolean;
	system_prompt?: string;
}

export interface DBStyleConfigJSON {
	browser_profile: Record<string, BrowserProfileEntry>;
	llm: Record<string, LLMEntry>;
	agent: Record<string, AgentEntry>;
}

export interface LoadedConfig {
	browser_profile: Record<string, any>;
	llm: Record<string, any>;
	agent: Record<string, any>;
}

// Helper to parse boolean from environment
function parseBoolEnv(value: string | undefined, defaultValue: boolean): boolean {
	if (!value) return defaultValue;
	const first = value.toLowerCase().charAt(0);
	return first === 't' || first === 'y' || first === '1';
}

// Helper to expand home directory
function expandUser(p: string): string {
	if (p.startsWith('~')) {
		return path.join(os.homedir(), p.slice(1));
	}
	return p;
}

// Cache for directory creation
let _dirsCreated = false;

function ensureDirs(configDir: string): void {
	if (!_dirsCreated) {
		try {
			fs.mkdirSync(configDir, { recursive: true });
			fs.mkdirSync(path.join(configDir, 'profiles'), { recursive: true });
			fs.mkdirSync(path.join(configDir, 'extensions'), { recursive: true });
			_dirsCreated = true;
		} catch {
			// Ignore errors
		}
	}
}

/**
 * Get configuration values
 */
export function getConfig(): BrowserUseConfig {
	const xdgCacheHome = expandUser(process.env.XDG_CACHE_HOME || '~/.cache');
	const xdgConfigHome = expandUser(process.env.XDG_CONFIG_HOME || '~/.config');
	const configDir = expandUser(process.env.BROWSER_USE_CONFIG_DIR || path.join(xdgConfigHome, 'browseruse'));

	// Ensure directories exist
	ensureDirs(configDir);

	const anonymizedTelemetry = parseBoolEnv(process.env.ANONYMIZED_TELEMETRY, true);

	// Determine IN_DOCKER: explicit env var takes precedence, then auto-detection
	const inDockerEnv = process.env.IN_DOCKER;
	const inDocker = inDockerEnv !== undefined ? parseBoolEnv(inDockerEnv, false) : isRunningInDocker();

	return {
		version: '1.0.0',
		defaultTimeout: 30000,
		maxRetries: 3,

		// Logging
		BROWSER_USE_LOGGING_LEVEL: (process.env.BROWSER_USE_LOGGING_LEVEL || 'info').toLowerCase(),
		CDP_LOGGING_LEVEL: process.env.CDP_LOGGING_LEVEL || 'WARNING',
		BROWSER_USE_DEBUG_LOG_FILE: process.env.BROWSER_USE_DEBUG_LOG_FILE || null,
		BROWSER_USE_INFO_LOG_FILE: process.env.BROWSER_USE_INFO_LOG_FILE || null,

		// Telemetry & Cloud
		ANONYMIZED_TELEMETRY: anonymizedTelemetry,
		BROWSER_USE_CLOUD_SYNC: parseBoolEnv(process.env.BROWSER_USE_CLOUD_SYNC, anonymizedTelemetry),
		BROWSER_USE_CLOUD_API_URL: process.env.BROWSER_USE_CLOUD_API_URL || 'https://api.browser-use.com',
		BROWSER_USE_CLOUD_UI_URL: process.env.BROWSER_USE_CLOUD_UI_URL || '',
		BROWSER_USE_MODEL_PRICING_URL: process.env.BROWSER_USE_MODEL_PRICING_URL || '',

		// Paths
		XDG_CACHE_HOME: xdgCacheHome,
		XDG_CONFIG_HOME: xdgConfigHome,
		BROWSER_USE_CONFIG_DIR: configDir,
		BROWSER_USE_CONFIG_FILE: path.join(configDir, 'config.json'),
		BROWSER_USE_CONFIG_PATH: process.env.BROWSER_USE_CONFIG_PATH || null,
		BROWSER_USE_PROFILES_DIR: path.join(configDir, 'profiles'),
		BROWSER_USE_DEFAULT_USER_DATA_DIR: path.join(configDir, 'profiles', 'default'),
		BROWSER_USE_EXTENSIONS_DIR: path.join(configDir, 'extensions'),

		// API Keys
		OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
		ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
		GOOGLE_API_KEY: process.env.GOOGLE_API_KEY || '',
		DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || '',
		GROK_API_KEY: process.env.GROK_API_KEY || '',
		NOVITA_API_KEY: process.env.NOVITA_API_KEY || '',
		AZURE_OPENAI_ENDPOINT: process.env.AZURE_OPENAI_ENDPOINT || '',
		AZURE_OPENAI_KEY: process.env.AZURE_OPENAI_KEY || '',
		SKIP_LLM_API_KEY_VERIFICATION: parseBoolEnv(process.env.SKIP_LLM_API_KEY_VERIFICATION, false),
		DEFAULT_LLM: process.env.DEFAULT_LLM || '',

		// Runtime hints
		IN_DOCKER: inDocker,
		IS_IN_EVALS: parseBoolEnv(process.env.IS_IN_EVALS, false),
		WIN_FONT_DIR: process.env.WIN_FONT_DIR || 'C:\\Windows\\Fonts',
		BROWSER_USE_VERSION_CHECK: parseBoolEnv(process.env.BROWSER_USE_VERSION_CHECK, true),
		BROWSER_USE_DISABLE_EXTENSIONS:
			process.env.BROWSER_USE_DISABLE_EXTENSIONS === undefined ? null : parseBoolEnv(process.env.BROWSER_USE_DISABLE_EXTENSIONS, false),
	};
}

/**
 * Legacy export for backward compatibility
 */
export const config = {
	version: '1.0.0',
	defaultTimeout: 30000,
	maxRetries: 3,
};

// ============================================================================
// Config.json Loading (from Python config.py)
// ============================================================================

/**
 * Create default config.json structure
 */
function createDefaultConfig(): DBStyleConfigJSON {
	const profileId = uuidv4();
	const llmId = uuidv4();
	const agentId = uuidv4();
	const now = new Date().toISOString();

	return {
		browser_profile: {
			[profileId]: {
				id: profileId,
				default: true,
				created_at: now,
				headless: false,
				user_data_dir: undefined,
				keep_alive: true,
			},
		},
		llm: {
			[llmId]: {
				id: llmId,
				default: true,
				created_at: now,
				model: 'o3',
				api_key: 'not-needed',
			},
		},
		agent: {
			[agentId]: {
				id: agentId,
				default: true,
				created_at: now,
			},
		},
	};
}

/**
 * Load and migrate config.json
 */
function loadAndMigrateConfig(configPath: string): DBStyleConfigJSON {
	if (!fs.existsSync(configPath)) {
		// Create fresh config with defaults
		const dir = path.dirname(configPath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		const newConfig = createDefaultConfig();
		fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2));
		return newConfig;
	}

	try {
		const data = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

		// Check if it's already in DB-style format
		if (
			data.browser_profile &&
			data.llm &&
			data.agent &&
			typeof data.browser_profile === 'object' &&
			typeof data.llm === 'object' &&
			typeof data.agent === 'object'
		) {
			// Check if the values are DB-style entries (have UUIDs as keys)
			const profiles = Object.values(data.browser_profile);
			if (profiles.length > 0 && profiles.every((v: any) => typeof v === 'object' && v.id)) {
				// Already in new format
				return data as DBStyleConfigJSON;
			}
		}

		// Old format detected - delete it and create fresh config
		console.error(`Old config format detected at ${configPath}, creating fresh config`);
		const newConfig = createDefaultConfig();
		fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2));
		return newConfig;
	} catch (error) {
		console.error(`Failed to load config from ${configPath}: ${error}, creating fresh config`);
		const newConfig = createDefaultConfig();
		try {
			fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2));
		} catch (writeError) {
			console.error(`Failed to write fresh config: ${writeError}`);
		}
		return newConfig;
	}
}

/**
 * Get default profile from DB config
 */
function getDefaultProfileFromDB(dbConfig: DBStyleConfigJSON): Record<string, any> {
	for (const profile of Object.values(dbConfig.browser_profile)) {
		if (profile.default) {
			return { ...profile };
		}
	}
	const profiles = Object.values(dbConfig.browser_profile);
	if (profiles.length > 0) {
		return { ...profiles[0] };
	}
	return {};
}

/**
 * Get default LLM from DB config
 */
function getDefaultLLMFromDB(dbConfig: DBStyleConfigJSON): Record<string, any> {
	for (const llm of Object.values(dbConfig.llm)) {
		if (llm.default) {
			return { ...llm };
		}
	}
	const llms = Object.values(dbConfig.llm);
	if (llms.length > 0) {
		return { ...llms[0] };
	}
	return {};
}

/**
 * Get default agent from DB config
 */
function getDefaultAgentFromDB(dbConfig: DBStyleConfigJSON): Record<string, any> {
	for (const agent of Object.values(dbConfig.agent)) {
		if (agent.default) {
			return { ...agent };
		}
	}
	const agents = Object.values(dbConfig.agent);
	if (agents.length > 0) {
		return { ...agents[0] };
	}
	return {};
}

/**
 * Load browser-use configuration.
 * Combines config.json with environment variable overrides.
 * Port from browser_use/config.py load_browser_use_config()
 */
export function loadBrowserUseConfig(): LoadedConfig {
	const cfg = getConfig();
	const configPath = cfg.BROWSER_USE_CONFIG_FILE;
	const dbConfig = loadAndMigrateConfig(configPath);

	// Get default entries
	const browserProfile = getDefaultProfileFromDB(dbConfig);
	const llm = getDefaultLLMFromDB(dbConfig);
	const agent = getDefaultAgentFromDB(dbConfig);

	const loadedConfig: LoadedConfig = {
		browser_profile: browserProfile,
		llm: llm,
		agent: agent,
	};

	// Apply env var overrides
	if (process.env.BROWSER_USE_HEADLESS !== undefined) {
		const headless = process.env.BROWSER_USE_HEADLESS.toLowerCase();
		loadedConfig.browser_profile.headless = headless === 'true' || headless === '1';
	}

	if (process.env.BROWSER_USE_ALLOWED_DOMAINS) {
		const domains = process.env.BROWSER_USE_ALLOWED_DOMAINS.split(',')
			.map((d) => d.trim())
			.filter((d) => d);
		loadedConfig.browser_profile.allowed_domains = domains;
	}

	// Proxy settings
	const proxyDict: Record<string, any> = {};
	if (process.env.BROWSER_USE_PROXY_URL) {
		proxyDict.server = process.env.BROWSER_USE_PROXY_URL;
	}
	if (process.env.BROWSER_USE_NO_PROXY) {
		proxyDict.bypass = process.env.BROWSER_USE_NO_PROXY.split(',')
			.map((d) => d.trim())
			.filter((d) => d)
			.join(',');
	}
	if (process.env.BROWSER_USE_PROXY_USERNAME) {
		proxyDict.username = process.env.BROWSER_USE_PROXY_USERNAME;
	}
	if (process.env.BROWSER_USE_PROXY_PASSWORD) {
		proxyDict.password = process.env.BROWSER_USE_PROXY_PASSWORD;
	}
	if (Object.keys(proxyDict).length > 0) {
		loadedConfig.browser_profile.proxy = proxyDict;
	}

	if (process.env.OPENAI_API_KEY) {
		loadedConfig.llm.api_key = process.env.OPENAI_API_KEY;
	}

	if (process.env.BROWSER_USE_LLM_MODEL) {
		loadedConfig.llm.model = process.env.BROWSER_USE_LLM_MODEL;
	}

	return loadedConfig;
}

/**
 * Get default browser profile from loaded config.
 * Removes metadata fields (id, default, created_at).
 * Port from browser_use/config.py get_default_profile()
 */
export function getDefaultProfile(config: LoadedConfig): Record<string, any> {
	const profile = config.browser_profile || {};
	if (typeof profile === 'object') {
		const { id, default: _, created_at, ...cleanProfile } = profile as any;
		return cleanProfile;
	}
	return {};
}

/**
 * Get default LLM config from loaded config.
 * Removes metadata fields (id, default, created_at).
 * Port from browser_use/config.py get_default_llm()
 */
export function getDefaultLLM(config: LoadedConfig): Record<string, any> {
	const llm = config.llm || {};
	if (typeof llm === 'object') {
		const { id, default: _, created_at, ...cleanLLM } = llm as any;
		return cleanLLM;
	}
	return {};
}

/**
 * Get default agent config from loaded config.
 * Removes metadata fields (id, default, created_at).
 */
export function getDefaultAgent(config: LoadedConfig): Record<string, any> {
	const agent = config.agent || {};
	if (typeof agent === 'object') {
		const { id, default: _, created_at, ...cleanAgent } = agent as any;
		return cleanAgent;
	}
	return {};
}
