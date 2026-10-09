import type { UiModule } from '../http.js'
import { imageBatchModule } from './image-batch.js'
import { imageHashModule } from './image-hash.js'

export const UI_MODULES: UiModule[] = [imageHashModule, imageBatchModule]
