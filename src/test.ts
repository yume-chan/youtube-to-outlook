import "reflect-metadata";

import { createConnection } from "typeorm";

import { Video } from "./entity/video";
import { Snippet } from "./entity/snippet";
import { LiveStreamingDetails } from "./entity/live-streaming-details";

(async () => {
    await createConnection();

    let video = await Video.findOne();
    console.log(video?.snippet);
})();
