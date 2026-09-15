/**
 * Actor utilities
 * Port from browser_use/actor/utils.py
 */

/**
 * Get the code and windowsVirtualKeyCode for a key.
 *
 * @param key Key name (e.g., 'Enter', 'ArrowUp', 'a', 'A')
 * @returns Tuple of [code, windowsVirtualKeyCode]
 *
 * Reference: Windows Virtual Key Codes
 * https://docs.microsoft.com/en-us/windows/win32/inputdev/virtual-key-codes
 */
export function getKeyInfo(key: string): [string, number | null] {
	// Complete mapping of key names to [code, virtualKeyCode]
	// Based on standard Windows Virtual Key Codes
	const keyMap: Record<string, [string, number]> = {
		// Navigation keys
		'Backspace': ['Backspace', 8],
		'Tab': ['Tab', 9],
		'Enter': ['Enter', 13],
		'Escape': ['Escape', 27],
		'Space': ['Space', 32],
		' ': ['Space', 32],
		'PageUp': ['PageUp', 33],
		'PageDown': ['PageDown', 34],
		'End': ['End', 35],
		'Home': ['Home', 36],
		'ArrowLeft': ['ArrowLeft', 37],
		'ArrowUp': ['ArrowUp', 38],
		'ArrowRight': ['ArrowRight', 39],
		'ArrowDown': ['ArrowDown', 40],
		'Insert': ['Insert', 45],
		'Delete': ['Delete', 46],
		// Modifier keys
		'Shift': ['ShiftLeft', 16],
		'ShiftLeft': ['ShiftLeft', 16],
		'ShiftRight': ['ShiftRight', 16],
		'Control': ['ControlLeft', 17],
		'ControlLeft': ['ControlLeft', 17],
		'ControlRight': ['ControlRight', 17],
		'Alt': ['AltLeft', 18],
		'AltLeft': ['AltLeft', 18],
		'AltRight': ['AltRight', 18],
		'Meta': ['MetaLeft', 91],
		'MetaLeft': ['MetaLeft', 91],
		'MetaRight': ['MetaRight', 92],
		// Function keys F1-F24
		'F1': ['F1', 112],
		'F2': ['F2', 113],
		'F3': ['F3', 114],
		'F4': ['F4', 115],
		'F5': ['F5', 116],
		'F6': ['F6', 117],
		'F7': ['F7', 118],
		'F8': ['F8', 119],
		'F9': ['F9', 120],
		'F10': ['F10', 121],
		'F11': ['F11', 122],
		'F12': ['F12', 123],
		'F13': ['F13', 124],
		'F14': ['F14', 125],
		'F15': ['F15', 126],
		'F16': ['F16', 127],
		'F17': ['F17', 128],
		'F18': ['F18', 129],
		'F19': ['F19', 130],
		'F20': ['F20', 131],
		'F21': ['F21', 132],
		'F22': ['F22', 133],
		'F23': ['F23', 134],
		'F24': ['F24', 135],
		// Numpad keys
		'NumLock': ['NumLock', 144],
		'Numpad0': ['Numpad0', 96],
		'Numpad1': ['Numpad1', 97],
		'Numpad2': ['Numpad2', 98],
		'Numpad3': ['Numpad3', 99],
		'Numpad4': ['Numpad4', 100],
		'Numpad5': ['Numpad5', 101],
		'Numpad6': ['Numpad6', 102],
		'Numpad7': ['Numpad7', 103],
		'Numpad8': ['Numpad8', 104],
		'Numpad9': ['Numpad9', 105],
		'NumpadMultiply': ['NumpadMultiply', 106],
		'NumpadAdd': ['NumpadAdd', 107],
		'NumpadSubtract': ['NumpadSubtract', 109],
		'NumpadDecimal': ['NumpadDecimal', 110],
		'NumpadDivide': ['NumpadDivide', 111],
		// Lock keys
		'CapsLock': ['CapsLock', 20],
		'ScrollLock': ['ScrollLock', 145],
		// OEM/Punctuation keys (US keyboard layout)
		'Semicolon': ['Semicolon', 186],
		';': ['Semicolon', 186],
		'Equal': ['Equal', 187],
		'=': ['Equal', 187],
		'Comma': ['Comma', 188],
		',': ['Comma', 188],
		'Minus': ['Minus', 189],
		'-': ['Minus', 189],
		'Period': ['Period', 190],
		'.': ['Period', 190],
		'Slash': ['Slash', 191],
		'/': ['Slash', 191],
		'Backquote': ['Backquote', 192],
		'`': ['Backquote', 192],
		'BracketLeft': ['BracketLeft', 219],
		'[': ['BracketLeft', 219],
		'Backslash': ['Backslash', 220],
		'\\': ['Backslash', 220],
		'BracketRight': ['BracketRight', 221],
		']': ['BracketRight', 221],
		'Quote': ['Quote', 222],
		"'": ['Quote', 222],
		// Media/Browser keys
		'AudioVolumeMute': ['AudioVolumeMute', 173],
		'AudioVolumeDown': ['AudioVolumeDown', 174],
		'AudioVolumeUp': ['AudioVolumeUp', 175],
		'MediaTrackNext': ['MediaTrackNext', 176],
		'MediaTrackPrevious': ['MediaTrackPrevious', 177],
		'MediaStop': ['MediaStop', 178],
		'MediaPlayPause': ['MediaPlayPause', 179],
		'BrowserBack': ['BrowserBack', 166],
		'BrowserForward': ['BrowserForward', 167],
		'BrowserRefresh': ['BrowserRefresh', 168],
		'BrowserStop': ['BrowserStop', 169],
		'BrowserSearch': ['BrowserSearch', 170],
		'BrowserFavorites': ['BrowserFavorites', 171],
		'BrowserHome': ['BrowserHome', 172],
		// Additional common keys
		'Clear': ['Clear', 12],
		'Pause': ['Pause', 19],
		'Select': ['Select', 41],
		'Print': ['Print', 42],
		'Execute': ['Execute', 43],
		'PrintScreen': ['PrintScreen', 44],
		'Help': ['Help', 47],
		'ContextMenu': ['ContextMenu', 93],
	};

	if (key in keyMap) {
		return keyMap[key];
	}

	// Handle alphanumeric keys dynamically
	if (key.length === 1) {
		if (/[a-zA-Z]/.test(key)) {
			// Letter keys: A-Z have VK codes 65-90
			return [`Key${key.toUpperCase()}`, key.toUpperCase().charCodeAt(0)];
		} else if (/[0-9]/.test(key)) {
			// Digit keys: 0-9 have VK codes 48-57 (same as ASCII)
			return [`Digit${key}`, key.charCodeAt(0)];
		}
	}

	// Fallback: use the key name as code, no virtual key code
	return [key, null];
}

/**
 * Modifier type for keyboard events
 */
export type ModifierType = 'Alt' | 'Control' | 'Meta' | 'Shift';

/**
 * Mouse button type
 */
export type MouseButton = 'left' | 'middle' | 'right' | 'back' | 'forward';

/**
 * 2D position coordinates
 */
export interface Position {
	x: number;
	y: number;
}

/**
 * Element bounding box with position and dimensions
 */
export interface BoundingBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * Basic information about a DOM element
 */
export interface ElementInfo {
	backendNodeId: number;
	nodeId: number | null;
	nodeName: string;
	nodeType: number;
	nodeValue: string | null;
	attributes: Record<string, string>;
	boundingBox: BoundingBox | null;
	error: string | null;
}

/**
 * Generate a CSS selector for an element
 */
export function generateSelector(element: any): string {
	if (!element) return '';

	const parts: string[] = [];

	// Try ID first
	if (element.id) {
		return `#${element.id}`;
	}

	// Build tag + class selector
	let selector = element.tagName?.toLowerCase() || '';

	if (element.className && typeof element.className === 'string') {
		const classes = element.className.split(/\s+/).filter(Boolean);
		if (classes.length > 0) {
			selector += '.' + classes.join('.');
		}
	}

	return selector || '*';
}

/**
 * Get character modifiers and virtual key code
 */
export function getCharModifiersAndVK(char: string): [number, number, string] {
	// Characters that require Shift modifier
	const shiftChars: Record<string, [string, number]> = {
		'!': ['1', 49],
		'@': ['2', 50],
		'#': ['3', 51],
		'$': ['4', 52],
		'%': ['5', 53],
		'^': ['6', 54],
		'&': ['7', 55],
		'*': ['8', 56],
		'(': ['9', 57],
		')': ['0', 48],
		'_': ['-', 189],
		'+': ['=', 187],
		'{': ['[', 219],
		'}': [']', 221],
		'|': ['\\', 220],
		':': [';', 186],
		'"': ["'", 222],
		'<': [',', 188],
		'>': ['.', 190],
		'?': ['/', 191],
		'~': ['`', 192],
	};

	// Check if character requires Shift
	if (char in shiftChars) {
		const [baseKey, vkCode] = shiftChars[char];
		return [8, vkCode, baseKey]; // Shift=8
	}

	// Some Unicode letters' toUpperCase()/toLowerCase() expand to several code
	// points ('ß' -> 'SS', 'ﬃ' -> 'FFI'). Fall back to the original char's code
	// point for the VK code in that case (upstream `_vk_from`).
	const vkFrom = (c: string): number => {
		const up = c.toUpperCase();
		return up.length === 1 ? up.charCodeAt(0) : c.charCodeAt(0);
	};

	// Uppercase letters require Shift
	if (char >= 'A' && char <= 'Z') {
		return [8, char.charCodeAt(0), char.toLowerCase()]; // Shift=8
	}

	// Lowercase letters
	if (char >= 'a' && char <= 'z') {
		return [0, char.toUpperCase().charCodeAt(0), char];
	}

	// Non-ASCII letters (é, ß, ...): mirror the ASCII branches, guarding the multi-code-point cases
	if (/\p{Lu}/u.test(char)) {
		const lower = char.toLowerCase();
		return [8, char.charCodeAt(0), lower.length === 1 ? lower : char]; // Shift=8
	}
	if (/\p{Ll}/u.test(char)) {
		return [0, vkFrom(char), char];
	}

	// Numbers
	if (char >= '0' && char <= '9') {
		return [0, char.charCodeAt(0), char];
	}

	// Special characters without Shift
	const noShiftChars: Record<string, number> = {
		' ': 32,
		'-': 189,
		'=': 187,
		'[': 219,
		']': 221,
		'\\': 220,
		';': 186,
		"'": 222,
		',': 188,
		'.': 190,
		'/': 191,
		'`': 192,
	};

	if (char in noShiftChars) {
		return [0, noShiftChars[char], char];
	}

	// Fallback
	const fallbackCode = /\p{L}/u.test(char) ? vkFrom(char) : char.charCodeAt(0);
	return [0, fallbackCode, char];
}

/**
 * Get the proper key code for a character
 */
export function getKeyCodeForChar(char: string): string {
	const keyCodes: Record<string, string> = {
		' ': 'Space',
		'.': 'Period',
		',': 'Comma',
		'-': 'Minus',
		'_': 'Minus',
		'@': 'Digit2',
		'!': 'Digit1',
		'?': 'Slash',
		':': 'Semicolon',
		';': 'Semicolon',
		'(': 'Digit9',
		')': 'Digit0',
		'[': 'BracketLeft',
		']': 'BracketRight',
		'{': 'BracketLeft',
		'}': 'BracketRight',
		'/': 'Slash',
		'\\': 'Backslash',
		'=': 'Equal',
		'+': 'Equal',
		'*': 'Digit8',
		'&': 'Digit7',
		'%': 'Digit5',
		'$': 'Digit4',
		'#': 'Digit3',
		'^': 'Digit6',
		'~': 'Backquote',
		'`': 'Backquote',
		'"': 'Quote',
		"'": 'Quote',
		'<': 'Comma',
		'>': 'Period',
		'|': 'Backslash',
	};

	if (char in keyCodes) {
		return keyCodes[char];
	} else if (/[a-zA-Z]/.test(char)) {
		return `Key${char.toUpperCase()}`;
	} else if (/[0-9]/.test(char)) {
		return `Digit${char}`;
	} else {
		return /[a-zA-Z]/.test(char) ? `Key${char.toUpperCase()}` : 'Unidentified';
	}
}
