import { setIcon } from 'obsidian';

/**
 * A bottom sheet: a panel that slides up from the bottom of the view with a
 * dimmed backdrop. Used for the overflow menu and the tab switcher, which is
 * where a phone browser conventionally puts them.
 *
 * The sheet is absolutely positioned inside the browser view rather than fixed
 * to the window, because a view is one pane of Obsidian's workspace and a fixed
 * panel would escape it and cover the rest of the app.
 */
export class Sheet {
	readonly el: HTMLElement;
	readonly body: HTMLElement;
	private readonly panel: HTMLElement;
	private closed = false;
	private readonly dismissHandlers: Array<() => void> = [];

	constructor(
		private readonly container: HTMLElement,
		title?: string,
	) {
		this.el = container.createDiv({ cls: 'bfm-sheet-overlay' });
		this.panel = this.el.createDiv({ cls: 'bfm-sheet' });
		const grabber = this.panel.createDiv({ cls: 'bfm-sheet-grabber' });
		// Dragging the grabber (or anywhere on the sheet) pulls it down to close.
		grabber.addEventListener('pointerdown', (event) => this.startDrag(event));

		if (title) {
			const header = this.panel.createDiv({ cls: 'bfm-sheet-title' });
			header.setText(title);
			header.addEventListener('pointerdown', (event) => this.startDrag(event));
		}

		this.body = this.panel.createDiv({ cls: 'bfm-sheet-body' });
		// Tapping the dimmed area outside the sheet dismisses it, as on a phone.
		this.el.addEventListener('click', (event) => {
			if (event.target === this.el) this.close();
		});
		this.el.addEventListener('keydown', (event) => {
			if (event.key === 'Escape') this.close();
		});
		this.el.setAttribute('tabindex', '-1');
	}

	/** Run when the sheet closes, whether dismissed or closed programmatically. */
	onDismiss(handler: () => void): void {
		this.dismissHandlers.push(handler);
	}

	/** Add a tappable row with an icon and a label. Returns the row element. */
	addRow(icon: string, label: string, onClick: () => void, options?: { danger?: boolean }): HTMLElement {
		const row = this.body.createDiv({ cls: 'bfm-sheet-row' });
		if (options?.danger) row.addClass('is-danger');
		const iconEl = row.createSpan({ cls: 'bfm-sheet-row-icon' });
		setIcon(iconEl, icon);
		row.createSpan({ cls: 'bfm-sheet-row-label', text: label });
		row.addEventListener('click', () => {
			this.close();
			onClick();
		});
		return row;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.el.remove();
		for (const handler of this.dismissHandlers) handler();
	}

	/**
	 * Drag-to-dismiss. The sheet follows the finger downwards and snaps back if
	 * released too high, which is what makes it feel native rather than like a
	 * dialog. Only downward movement is tracked, so an upward drag does nothing.
	 */
	private startDrag(event: PointerEvent): void {
		if (event.button !== 0 && event.pointerType === 'mouse') return;
		const startY = event.clientY;
		let offset = 0;
		const panel = this.panel;
		panel.addClass('is-dragging');

		const onMove = (move: PointerEvent) => {
			offset = Math.max(0, move.clientY - startY);
			panel.setCssProps({ transform: `translateY(${offset}px)` });
		};
		const onUp = () => {
			panel.removeClass('is-dragging');
			panel.setCssProps({ transform: '' });
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
			window.removeEventListener('pointercancel', onUp);
			if (offset > 80) this.close();
		};
		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp);
		window.addEventListener('pointercancel', onUp);
	}
}
