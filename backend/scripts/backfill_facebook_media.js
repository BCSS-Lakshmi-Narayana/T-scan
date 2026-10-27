require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const Content = require('../src/models/Content');
const { archiveFacebookMedia } = require('../src/services/contentS3Service');

const limit = Number(process.argv[2] || 100);

const hasS3Gaps = (media = []) => {
  if (!Array.isArray(media) || media.length === 0) return false;
  return media.some((item) => {
    const hasSource = Boolean(item?.video_url || item?.url);
    return hasSource && !item?.s3_url;
  });
};

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, {
    dbName: process.env.DB_NAME
  });

  const contents = await Content.find({
    platform: 'facebook',
    media: { $exists: true, $ne: [] }
  })
    .sort({ published_at: -1, created_at: -1 })
    .limit(limit)
    .lean();

  let scanned = 0;
  let updated = 0;
  let failed = 0;

  for (const content of contents) {
    scanned += 1;
    if (!hasS3Gaps(content.media)) continue;

    try {
      const archivedMedia = await archiveFacebookMedia(content.media, content.content_id || content.id, {
        postUrl: content.content_url,
        replaceOriginalUrls: false
      });

      await Content.updateOne(
        { id: content.id },
        {
          $set: {
            media: archivedMedia,
            is_media_archived: archivedMedia.length > 0 && !hasS3Gaps(archivedMedia)
          }
        }
      );

      updated += 1;
      console.log(`[facebook-backfill] updated ${content.content_id || content.id}`);
    } catch (error) {
      failed += 1;
      console.error(`[facebook-backfill] failed ${content.content_id || content.id}: ${error.message}`);
    }
  }

  console.log(JSON.stringify({ scanned, updated, failed }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
