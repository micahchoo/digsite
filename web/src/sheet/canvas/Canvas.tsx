import { forwardRef } from 'react';
import { NativeCanvas } from './native/index.ts';
import type { CanvasHandle, CanvasProps } from './types.ts';

export const Canvas = forwardRef<CanvasHandle, CanvasProps>(
  function Canvas(props, ref) {
    return <NativeCanvas ref={ref} {...props} />;
  },
);
