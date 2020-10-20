/* eslint-disable no-unused-expressions */
import { ISharpGatsbyImageData } from "gatsby-plugin-image"
import { GatsbyCache, Node } from "gatsby"
import { Reporter } from "gatsby-cli/lib/reporter/reporter"
import { rgbToHex, calculateImageSizes, getSrcSet, getSizes } from "./utils"
import { traceSVG, getImageSizeAsync, base64, batchQueueImageResizing } from "."
import type { SharpInstance } from "sharp"
import sharp from "./safe-sharp"
import { createTransformObject } from "./plugin-options"
export interface ISharpGatsbyImageArgs {
  layout?: "fixed" | "fluid" | "constrained"
  placeholder?: "tracedSVG" | "dominantColor" | "blurred" | "none"
  tracedSVGOptions?: Record<string, unknown>
  width?: number
  height?: number
  maxWidth?: number
  maxHeight?: number
  fit?: "contain" | "cover" | "fill" | "inside" | "outside"
  [key: string]: unknown
}
export type FileNode = Node & {
  absolutePath?: string
}

export interface IImageMetadata {
  width: number
  height: number
  format: string
  density?: string
  dominantColor?: string
}

const metadataCache = new Map<string, IImageMetadata>()

export async function getImageMetadata(
  file: FileNode,
  getDominantColor?: boolean
): Promise<IImageMetadata> {
  if (!getDominantColor) {
    // If we don't need the dominant color we can use the cheaper size function
    const { width, height, type } = await getImageSizeAsync(file)
    return { width, height, format: type }
  }
  let metadata = metadataCache.get(file.internal.contentDigest)
  if (metadata && process.env.NODE_ENV !== `test`) {
    return metadata
  }
  const pipeline: SharpInstance = sharp(file.absolutePath)

  const { width, height, density, format } = await pipeline.metadata()

  const { dominant } = await pipeline.stats()
  // Fallback in case sharp doesn't support dominant
  const dominantColor = dominant
    ? rgbToHex(dominant.r, dominant.g, dominant.b)
    : `#000000`

  metadata = { width, height, density, format, dominantColor }
  metadataCache.set(file.internal.contentDigest, metadata)
  return metadata
}

export interface IImageDataProps {
  file: FileNode
  args: ISharpGatsbyImageArgs
  cache: GatsbyCache
  reporter: Reporter
}

export interface IImageDataArgs {
  file: FileNode
  args: ISharpGatsbyImageArgs
  cache: GatsbyCache
  reporter: Reporter
}

export function getOutputAspectRatio(
  {
    width,
    height,
    maxWidth,
    maxHeight,
    layout = `fixed`,
    fit = `cover`,
  }: ISharpGatsbyImageArgs,
  metadata: IImageMetadata
): number {
  // These maintain the input aspect ratio
  if (fit === `inside` || fit === `outside`) {
    return metadata.width / metadata.height
  }

  // If there's a width and height set, then calculate from that
  if (height && width && layout === `fixed`) {
    return width / height
  }

  // If there's a maxWidth and maxHeight, then we can get aspect ratio from there
  if (maxWidth && maxHeight && layout !== `fixed`) {
    return maxWidth / maxHeight
  }
  // Otherwise we use the aspect ratio of the source image
  return metadata.width / metadata.height
}

export async function generateImageData({
  file,
  args,
  reporter,
  cache,
}: IImageDataArgs): Promise<ISharpGatsbyImageData | undefined> {
  const {
    layout = `fixed`,
    placeholder = `dominantColor`,
    tracedSVGOptions = {},
  } = args

  const metadata = await getImageMetadata(file, placeholder === `dominantColor`)

  const imageSizes: {
    sizes: Array<number>
    presentationWidth: number
    presentationHeight: number
    aspectRatio: number
  } = calculateImageSizes({
    file,
    layout,
    ...args,
    imgDimensions: metadata,
    reporter,
  })

  const transforms = imageSizes.sizes.map(outputWidth => {
    const width = Math.round(outputWidth)
    const transform = createTransformObject({
      ...args,
      width,
      height: Math.round(width / imageSizes.aspectRatio),
      toFormat: args.toFormat || metadata.format,
    })
    return transform
  })

  const images = batchQueueImageResizing({
    file,
    transforms,
    reporter,
  })

  const srcSet = getSrcSet(images)
  const sizes = args.sizes || getSizes(imageSizes.presentationWidth)

  const primaryIndex = imageSizes.sizes.findIndex(
    size => size === imageSizes.presentationWidth
  )

  const primaryImage = images[primaryIndex]

  if (!images?.length) {
    return undefined
  }
  const imageProps: ISharpGatsbyImageData = {
    layout,
    placeholder: undefined,
    images: {
      fallback: {
        src: primaryImage.src,
        srcSet,
        sizes,
      },
      sources: [],
    },
  }

  if (args.webP) {
    const transforms = imageSizes.sizes.map(outputWidth => {
      const width = Math.round(outputWidth)
      const transform = createTransformObject({
        ...args,
        width,
        height: Math.round(width / imageSizes.aspectRatio),
        toFormat: `webp`,
      })
      return transform
    })

    const webpImages = batchQueueImageResizing({
      file,
      transforms,
      reporter,
    })
    const webpSrcSet = getSrcSet(webpImages)

    imageProps.images.sources?.push({
      srcSet: webpSrcSet,
      type: `image/webp`,
      sizes,
    })
  }

  if (placeholder === `blurred`) {
    const { src: fallback } = await base64({
      file,
      args: { ...args, width: args.base64Width, height: args.base64Height },
      reporter,
    })
    imageProps.placeholder = {
      fallback,
    }
  } else if (placeholder === `tracedSVG`) {
    const fallback: string = await traceSVG({
      file,
      args: tracedSVGOptions,
      fileArgs: args,
      cache,
      reporter,
    })
    imageProps.placeholder = {
      fallback,
    }
  } else if (metadata.dominantColor) {
    imageProps.backgroundColor = metadata.dominantColor
  }

  primaryImage.aspectRatio = primaryImage.aspectRatio || 1

  switch (layout) {
    case `fixed`:
      imageProps.width = primaryImage.width
      imageProps.height = primaryImage.height
      break

    case `fluid`:
      imageProps.width = 1
      imageProps.height = 1 / primaryImage.aspectRatio
      break

    case `constrained`:
      imageProps.width = args.maxWidth || primaryImage.width || 1
      imageProps.height = (imageProps.width || 1) / primaryImage.aspectRatio
  }

  return imageProps
}
