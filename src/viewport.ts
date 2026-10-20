/**
 * The bottom of the layout, in CSS pixels, that the soft keyboard covers.
 *
 * On a phone the on-screen keyboard shrinks the *visual* viewport without
 * changing the layout viewport, so a bar pinned to the bottom of the layout is
 * drawn underneath the keyboard and becomes unreachable. `visualViewport`
 * reports the visible box, so the covered height is the layout height minus the
 * visible height, offset by however far the visual viewport has been scrolled.
 *
 * Returns 0 when the keyboard is closed (the two heights match) and is safe to
 * call where `visualViewport` is missing (older WebViews), so the caller can
 * apply the result unconditionally.
 */
export function keyboardInset(
	viewport: { height: number; offsetTop: number } | null | undefined,
	layoutHeight: number,
): number {
	if (!viewport) return 0;
	if (!Number.isFinite(viewport.height) || !Number.isFinite(viewport.offsetTop)) return 0;
	if (!Number.isFinite(layoutHeight)) return 0;
	const covered = layoutHeight - viewport.height - viewport.offsetTop;
	return covered > 0 ? Math.round(covered) : 0;
}
