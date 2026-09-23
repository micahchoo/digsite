/** Alpha used for relation emphasis in the canvas and foreign overlay. */
export function relationOpacity(
  relation: string,
  focus: string | null,
): number {
  return focus !== null && relation !== focus ? 0.12 : 1;
}
