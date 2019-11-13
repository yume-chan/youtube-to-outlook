import { Entity, PrimaryGeneratedColumn, Column } from "typeorm";

@Entity()
export class Snippet {
    @PrimaryGeneratedColumn()
    public id!: string;

    @Column()
    public publishedAt!: Date;

    @Column()
    public channelId!: string;

    @Column()
    public title!: string;

    @Column()
    public liveBroadcastContent!: 'none' | 'live' | 'upcoming';
}
