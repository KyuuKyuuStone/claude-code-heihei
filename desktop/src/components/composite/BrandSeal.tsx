import { cx } from '@/lib/cx'
import { publicAssetPath } from '@/lib/publicAsset'

/**
 * The cc-heihei mark — the app icon (a winking smiley in a rounded square).
 * Rendered as an image so the in-app mark always matches the installed app icon.
 */
export type BrandSealSize = 'sm' | 'md' | 'lg' | 'xl'

const SIZES: Record<BrandSealSize, { box: string }> = {
  sm: { box: 'h-6 w-6' },
  md: { box: 'h-8 w-8' },
  lg: { box: 'h-[38px] w-[38px]' },
  xl: { box: 'h-20 w-20' },
}

export type BrandSealProps = {
  size?: BrandSealSize
  className?: string
}

export function BrandSeal({ size = 'md', className }: BrandSealProps) {
  const spec = SIZES[size]

  return (
    <img
      src={publicAssetPath('app-icon.png')}
      alt=""
      aria-hidden="true"
      className={cx('flex-shrink-0 object-contain', spec.box, className)}
    />
  )
}
