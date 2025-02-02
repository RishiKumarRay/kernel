import { SceneLifeCycleStatus, SceneLifeCycleStatusType } from '../lib/scene.status'
import future, { IFuture } from 'fp-future'
import { EventEmitter } from 'events'
import { SceneDataDownloadManager } from './download'
import { Observable } from 'mz-observable'
import defaultLogger from 'shared/logger'

export type SceneLifeCycleStatusReport = { sceneId: string; status: SceneLifeCycleStatusType }
export type NewDrawingDistanceReport = { distanceInParcels: number }

export const sceneLifeCycleObservable = new Observable<Readonly<SceneLifeCycleStatusReport>>()
export const renderDistanceObservable = new Observable<Readonly<NewDrawingDistanceReport>>()

type SceneId = string

export class SceneLifeCycleController extends EventEmitter {
  private downloadManager: SceneDataDownloadManager

  private _positionToSceneId = new Map<string, SceneId | undefined>()
  private futureOfPositionToSceneId = new Map<string, IFuture<SceneId | undefined>>()
  private sceneStatus = new Map<SceneId, SceneLifeCycleStatus>()
  private enabledEmpty: boolean

  constructor(opts: { downloadManager: SceneDataDownloadManager; enabledEmpty: boolean }) {
    super()
    this.downloadManager = opts.downloadManager
    this.enabledEmpty = opts.enabledEmpty
  }

  async reportSightedParcels(sightedParcels: string[], lostSightParcels: string[]) {
    const sighted = await this.fetchSceneIds(sightedParcels)
    const lostSight = await this.fetchSceneIds(lostSightParcels)

    await this.startSceneLoading(sighted)

    const difference = this.diff(lostSight, sighted)
    this.unloadScenes(difference)

    return { sighted, lostSight: difference }
  }

  /** Unload the current scene, and load the new scenes on the same parcels as the original scene */
  async reloadScene(sceneId: SceneId) {
    const parcels = this.sceneStatus.get(sceneId)?.sceneDescription?.sceneJsonData?.scene?.parcels
    if (parcels) {
      // Invalidate parcel to scenes association
      this.invalidate(sceneId)

      // Unload and re-load scenes
      this.emit('Unload scene', sceneId)
      const newScenes = await this.fetchSceneIds(parcels)
      await this.startSceneLoading(newScenes)
    }
  }

  reportDataLoaded(sceneId: string) {
    if (this.sceneStatus.has(sceneId) && this.sceneStatus.get(sceneId)!.status === 'awake') {
      this.sceneStatus.get(sceneId)!.status = 'loaded'
      this.emit('Start scene', sceneId)
    }
  }

  isRenderable(sceneId: SceneId): boolean {
    const status = this.sceneStatus.get(sceneId)
    return !!status && (status.isReady() || status.isFailed())
  }

  reportStatus(sceneId: string, status: SceneLifeCycleStatusType) {
    const lifeCycleStatus = this.sceneStatus.get(sceneId)
    if (!lifeCycleStatus) {
      defaultLogger.info(`no lifecycle status for scene ${sceneId}`)
      return
    }
    lifeCycleStatus.status = status

    this.emit('Scene status', { sceneId, status })
  }

  invalidate(sceneId: string) {
    const parcels = this.sceneStatus.get(sceneId)?.sceneDescription?.sceneJsonData?.scene?.parcels
    if (parcels) {
      for (const parcel of parcels) {
        this._positionToSceneId.delete(parcel)
        this.futureOfPositionToSceneId.delete(parcel)
      }
      this.downloadManager.invalidateParcels(parcels)
    }
    this.sceneStatus.delete(sceneId)
  }

  private distinct(value: any, index: number, self: Array<any>) {
    return self.indexOf(value) === index
  }

  private diff<T>(a1: T[], a2: T[]): T[] {
    return a1.filter((i) => a2.indexOf(i) < 0)
  }

  private async fetchSceneIds(positions: string[]): Promise<string[]> {
    const sceneIds = await this.requestSceneIds(positions)

    return sceneIds.filter(($) => !!$).filter(this.distinct) as string[]
  }

  private async startSceneLoading(sceneIds: string[]) {
    sceneIds.forEach(async (sceneId) => {
      try {
        if (!this.sceneStatus.has(sceneId)) {
          const data = await this.downloadManager.resolveLandData(sceneId)
          if (data) {
            this.sceneStatus.set(sceneId, new SceneLifeCycleStatus(data))
          }
        }

        if (this.sceneStatus.get(sceneId)!.isDead()) {
          this.emit('Preload scene', sceneId)
          this.sceneStatus.get(sceneId)!.status = 'awake'
        }
      } catch (e) {
        defaultLogger.error(`error while loading scene ${sceneId}`, e)
      }
    })
  }

  private unloadScenes(sceneIds: string[]) {
    sceneIds.forEach((sceneId) => {
      const sceneStatus = this.sceneStatus.get(sceneId)
      if (sceneStatus && sceneStatus.isAwake()) {
        sceneStatus.status = 'unloaded'
        this.emit('Unload scene', sceneId)
      }
    })
  }

  private async requestSceneIds(tiles: string[]): Promise<(string | undefined)[]> {
    const futures: Promise<string | undefined>[] = []

    const missingTiles: string[] = []

    for (const tile of tiles) {
      let promise: IFuture<string | undefined>

      if (this._positionToSceneId.has(tile)) {
        promise = this.futureOfPositionToSceneId.get(tile)!
      } else {
        promise = future()

        this.futureOfPositionToSceneId.set(tile, promise)
        missingTiles.push(tile)
      }

      futures.push(promise)
    }

    if (missingTiles.length > 0) {
      const pairs = await this.downloadManager.resolveSceneSceneIds(missingTiles)

      for (const [tile, sceneId] of pairs) {
        const result =
          sceneId ??
          // empty scene!
          (this.enabledEmpty ? ('Qm' + tile + 'm').padEnd(46, '0') : undefined)

        this.futureOfPositionToSceneId.get(tile)!.resolve(result)

        this._positionToSceneId.set(tile, result)
      }
    }

    return Promise.all(futures)
  }
}
