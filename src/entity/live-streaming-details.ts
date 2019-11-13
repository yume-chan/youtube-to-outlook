import { Entity, PrimaryGeneratedColumn, Column } from "typeorm";

@Entity()
export class LiveStreamingDetails {
    @PrimaryGeneratedColumn()
    public id!: string;

    @Column({ nullable: true })
    public actualStartTime?: Date;

    @Column({ nullable: true })
    public actualEndTime?: Date;

    @Column({ nullable: true })
    public scheduledStartTime?: Date;

    @Column({ nullable: true })
    public scheduledEndTime?: Date;
}
