import { Entity, Column, PrimaryColumn, OneToOne, BaseEntity, JoinColumn } from "typeorm";

import { Snippet } from "./snippet";
import { LiveStreamingDetails } from "./live-streaming-details";

@Entity()
export class Video extends BaseEntity {
    @PrimaryColumn()
    public id!: string;

    @Column()
    public deleted!: boolean;

    @OneToOne(() => Snippet, { cascade: true })
    @JoinColumn()
    public snippet!: Snippet;

    @OneToOne(() => LiveStreamingDetails, { cascade: true })
    @JoinColumn()
    public liveStreamingDetails!: LiveStreamingDetails;
}
