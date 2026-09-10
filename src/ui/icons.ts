import { addIcon } from 'obsidian';

/**
 * Obsidian draws a registered icon inside a 0 0 100 100 viewBox and colours it
 * with currentColor, so what is registered is the inner markup only. Anything
 * authored at another size is scaled here rather than redrawn, which keeps the
 * source identical to the file it came from.
 */
const SCALE_24_TO_100 = 100 / 24;

/** The plugin's own mark: a branch merging back into the main line. */
const LOGO = `
<g transform="scale(${SCALE_24_TO_100})" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
	<path d="M7 4V20" />
	<path d="M17 5V9C17 12.314 14.314 15 11 15H7" />
	<path d="M10 12L7 15L10 18" />
	<circle cx="7" cy="4" r="2" fill="currentColor" stroke="none" />
	<circle cx="17" cy="5" r="2" fill="currentColor" stroke="none" />
	<circle cx="7" cy="20" r="2" fill="currentColor" stroke="none" />
</g>`;

/** Sits on the control that opens a new issue. */
const BUG = `
<g fill="none">
	<path d="M50 18 C36 18 27 29 27 45 V62 C27 75 36 84 50 84 C64 84 73 75 73 62 V45 C73 29 64 18 50 18Z" fill="currentColor" />
	<path d="M32 39 C32 27 39 19 50 19 C61 19 68 27 68 39 C68 44 65 47 61 47 H39 C35 47 32 44 32 39Z" fill="currentColor" />
	<circle cx="42" cy="34" r="3.5" fill="white" />
	<circle cx="58" cy="34" r="3.5" fill="white" />
	<path d="M39 23 C33 15 27 12 20 14" stroke="currentColor" stroke-width="5" stroke-linecap="round" />
	<path d="M61 23 C67 15 73 12 80 14" stroke="currentColor" stroke-width="5" stroke-linecap="round" />
	<path d="M29 48 L17 40 L10 42" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" />
	<path d="M28 59 L14 58 L8 63" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" />
	<path d="M29 70 L18 77 L14 85" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" />
	<path d="M71 48 L83 40 L90 42" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" />
	<path d="M72 59 L86 58 L92 63" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" />
	<path d="M71 70 L82 77 L86 85" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" />
	<path d="M50 48 V80" stroke="white" stroke-width="4" stroke-linecap="round" opacity="0.9" />
</g>`;

export const ULTISYNC_ICON = 'ultisync-logo';
export const BUG_ICON = 'ultisync-bug';

/** Called once on load, before anything asks for either by name. */
export function registerIcons(): void {
	addIcon(ULTISYNC_ICON, LOGO);
	addIcon(BUG_ICON, BUG);
}
