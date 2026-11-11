import {
  Archive, Boxes, Brain, Cog, Database, DatabaseZap, DoorOpen, Gauge, Globe, Layers, MemoryStick, Network, Plug, Satellite, Search, Server, ShieldCheck, Users,
} from 'lucide-react'
import type { Kind } from '../sim/types'

export const KIND_ICON: Record<Kind, React.ComponentType<{ size?: number; color?: string; strokeWidth?: number }>> = {
  client: Users, dns: Globe, cdn: Satellite, loadbalancer: Network, gateway: DoorOpen, ratelimiter: Gauge, auth: ShieldCheck,
  webserver: Server, microservice: Boxes, cache: MemoryStick, sqldb: Database, nosql: DatabaseZap, queue: Layers, worker: Cog,
  objectstorage: Archive, search: Search, external: Plug, llm: Brain,
}
