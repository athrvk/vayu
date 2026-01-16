/**
 * ID Generation Utilities
 */

/**
 * Generate a short random ID
 */
export const generateId = (): string => Math.random().toString(36).substring(2, 11);

/**
 * Generate a UUID v4
 */
export const generateUUID = (): string => {
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		const v = c === "x" ? r : (r & 0x3) | 0x8;
		return v.toString(16);
	});
};
