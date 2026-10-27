const Content = require('../models/Content');
// Must be the tenantModel proxy, not mongoose.model('Source'). The global mongoose
// registry only ever holds the control-plane models (Tenant, SuperAdmin, Counter,
// Influencer) — tenant schemas are compiled onto each tenant's own connection, so
// mongoose.model('Source') throws MissingSchemaError under TENANT_DB_MODE=per-tenant.
const Source = require('../models/Source');
const Analysis = require('../models/Analysis');
const { withTenant } = require('../utils/tenantFilter');
const { scopedDistrictQuery } = require('../utils/scopedDistricts');

// @desc    Get content feed with alerts (Paginated)
// @route   GET /api/content/feed
// @access  Private
const getContentFeed = async (req, res) => {
  try {
    const {
      platform,
      startDate,
      endDate,
      since,
      search,
      alert_type,
      keyword,
      limit = 20,
      page = 1,
      risk_level, // Added support for risk_level
      status, // Added support for status filtering (active, escalated, acknowledged, false_positive)
      source_id, // Added support for source_id filtering
      category // Added support for category filtering
    } = req.query;

    const matchStage = withTenant(req, scopedDistrictQuery(req));
    if (platform && platform !== 'all') matchStage.platform = platform;

    // Handle category filtering by pre-fetching source IDs
    let categorySourceIds = null;
    if (category && category !== 'all') {
      const sourcesInCategory = await Source.find(withTenant(req, { category: category.toLowerCase() })).select('id').lean();
      categorySourceIds = sourcesInCategory.map(s => s.id);
    }

    if (source_id || categorySourceIds !== null) {
      // Handle comma-separated string or array of source_ids
      const explicitSourceIds = source_id ? (Array.isArray(source_id) ? source_id : source_id.split(',').map(id => id.trim())) : [];

      const validObjectIds = explicitSourceIds.filter(id => mongoose.Types.ObjectId.isValid(id));
      let sourceMetaData = [];
      if (validObjectIds.length > 0) {
        sourceMetaData = await Source.find(withTenant(req, { _id: { $in: validObjectIds } })).select('id').lean();
      }

      const sourceIdValues = [];

      // Add explicit IDs
      for (const sid of explicitSourceIds) {
        sourceIdValues.push(sid);
        if (mongoose.Types.ObjectId.isValid(sid)) {
          sourceIdValues.push(new mongoose.Types.ObjectId(sid).toString());
          sourceIdValues.push(new mongoose.Types.ObjectId(sid));
          const meta = sourceMetaData.find(m => m._id.toString() === sid.toString());
          if (meta && meta.id) sourceIdValues.push(meta.id);
        }
      }

      // Final Source ID List:
      // If category is provided, we filter by categorySourceIds.
      // If source_id is ALSO provided, we could intersect, but usually users select one or the other.
      // For this implementation, if category is provided, we use it. If source_id is provided, we use it.
      // If BOTH are provided, we'll assume the user wants content from source_id AND matching category (OR behavior if we just append).
      // Actually, if category is provided, it should likely narrow down the results.

      let finalSourceIds;
      if (categorySourceIds !== null && source_id) {
        // Intersect
        finalSourceIds = sourceIdValues.filter(id => categorySourceIds.includes(id));
      } else if (categorySourceIds !== null) {
        finalSourceIds = categorySourceIds;
      } else {
        finalSourceIds = sourceIdValues;
      }

      if (finalSourceIds.length > 0) {
        matchStage.source_id = { $in: finalSourceIds };
      } else if (categorySourceIds !== null || source_id) {
        // If they filtered by something that resulted in 0 IDs, ensure 0 results
        matchStage.source_id = { $in: ['__none__'] };
      }
    }

    if (risk_level && risk_level !== 'all') matchStage.risk_level = risk_level.toLowerCase();

    // Handle time-based filtering
    if (since) {
      // 'since' is an ISO date string - get content since that time
      matchStage.published_at = { $gte: new Date(since) };
    } else if (startDate || endDate) {
      matchStage.published_at = {};
      if (startDate) matchStage.published_at.$gte = new Date(startDate);
      if (endDate) matchStage.published_at.$lte = new Date(endDate);
    }

    if (search) {
      // Split by whitespace or comma to get individual terms
      // Filter out empty strings
      const terms = search.trim().split(/[\s,]+/).filter(Boolean);

      //console.log('SEARCH DEBUG:', { original: search, terms });

      if (terms.length > 0) {
        // Escape each term individually
        const escapedTerms = terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

        // Join with OR operator
        const joinedPattern = escapedTerms.join('|');
        const searchRegex = { $regex: joinedPattern, $options: 'i' };

        matchStage.$or = [
          { text: searchRegex },
          { author: searchRegex },
          { author_handle: searchRegex }
        ];
      }
    }

    if (keyword) {
      const escaped = String(keyword).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      matchStage['risk_factors.keyword'] = { $regex: `^${escaped}`, $options: 'i' };
    }

    const basePipeline = [];
    if (Object.keys(matchStage).length > 0) basePipeline.push({ $match: matchStage });

    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.max(1, parseInt(limit) || 20);
    const skip = (pageNum - 1) * limitNum;

    // OPTIMIZATION: If we don't need to filter by calculated fields (alerts/keywords/status),
    // we should paginate FIRST to reduce lookup overhead.
    const isAllStatus = !status || status === 'all';
    const isAllAlert = !alert_type || alert_type === 'all';

    let items = [];
    let total = 0;

    if (isAllAlert && !keyword && isAllStatus) {
      basePipeline.push({ $sort: { published_at: -1 } });
      basePipeline.push({ $skip: skip });
      basePipeline.push({ $limit: limitNum });

      // Only perform expensive lookups on the 20 documents we actually return
      basePipeline.push({
        $lookup: {
          from: 'alerts',
          localField: 'id',
          foreignField: 'content_id',
          as: 'alerts'
        }
      });

      basePipeline.push({
        $lookup: {
          from: 'sources',
          localField: 'source_id',
          foreignField: 'id',
          as: 'source_meta'
        }
      });

      basePipeline.push({ $unwind: { path: '$source_meta', preserveNullAndEmptyArrays: true } });

      basePipeline.push({
        $lookup: {
          from: 'analyses',
          localField: 'id',
          foreignField: 'content_id',
          as: 'analysis'
        }
      });

      basePipeline.push({ $addFields: { analysis: { $arrayElemAt: ['$analysis', 0] } } });

      basePipeline.push({
        $addFields: {
          alert_types: { $map: { input: '$alerts', as: 'a', in: '$$a.alert_type' } },
          primary_alert: { $arrayElemAt: ['$alerts', 0] },
          has_risk_alert: { $gt: [{ $size: { $filter: { input: '$alerts', as: 'a', cond: { $in: ['$$a.alert_type', ['keyword_risk', 'ai_risk']] } } } }, 0] },
          has_viral_alert: { $gt: [{ $size: { $filter: { input: '$alerts', as: 'a', cond: { $eq: ['$$a.alert_type', 'velocity'] } } } }, 0] },
          has_new_post_alert: { $gt: [{ $size: { $filter: { input: '$alerts', as: 'a', cond: { $eq: ['$$a.alert_type', 'new_post'] } } } }, 0] },
          has_risk_detected: {
            $or: [
              { $in: ['$risk_level', ['medium', 'high', 'critical']] },
              { $gt: [{ $size: { $ifNull: ['$risk_factors', []] } }, 0] },
              { $gt: [{ $size: { $filter: { input: '$alerts', as: 'a', cond: { $in: ['$$a.alert_type', ['keyword_risk', 'ai_risk']] } } } }, 0] }
            ]
          }
        }
      });

      let itemsPromise = Content.aggregate(basePipeline);

      // Apply forced Equality-Sort index hints (source_id FIRST) to bypass slow query plans
      if (matchStage.source_id && !search && !keyword) {
        if (matchStage.platform) {
          itemsPromise = itemsPromise.hint({ platform: 1, source_id: 1, published_at: -1 });
        } else {
          itemsPromise = itemsPromise.hint({ source_id: 1, published_at: -1 });
        }
      }

      items = await itemsPromise;
      total = skip + items.length + (items.length === limitNum ? 1 : 0); // Approximate for hasMore calc
    } else {
      // Legacy path: Even here, we should try to optimize by pushing match and sort as high as possible.
      basePipeline.push({
        $lookup: {
          from: 'alerts',
          let: { contentId: '$id' },
          pipeline: [
            { $match: { $expr: { $eq: ['$content_id', '$$contentId'] } } },
            { $sort: { created_at: -1 } }
          ],
          as: 'alerts'
        }
      });

      basePipeline.push({
        $lookup: {
          from: 'sources',
          localField: 'source_id',
          foreignField: 'id',
          as: 'source_meta'
        }
      });

      basePipeline.push({
        $unwind: {
          path: '$source_meta',
          preserveNullAndEmptyArrays: true
        }
      });

      basePipeline.push({
        $lookup: {
          from: 'analyses',
          localField: 'id',
          foreignField: 'content_id',
          as: 'analysis'
        }
      });

      basePipeline.push({ $addFields: { analysis: { $arrayElemAt: ['$analysis', 0] } } });

      basePipeline.push({
        $addFields: {
          alert_types: {
            $map: {
              input: '$alerts',
              as: 'a',
              in: '$$a.alert_type'
            }
          },
          primary_alert: { $arrayElemAt: ['$alerts', 0] },
          has_risk_alert: {
            $gt: [
              {
                $size: {
                  $filter: {
                    input: '$alerts',
                    as: 'a',
                    cond: { $in: ['$$a.alert_type', ['keyword_risk', 'ai_risk']] }
                  }
                }
              },
              0
            ]
          },
          has_viral_alert: {
            $gt: [
              {
                $size: {
                  $filter: {
                    input: '$alerts',
                    as: 'a',
                    cond: { $eq: ['$$a.alert_type', 'velocity'] }
                  }
                }
              },
              0
            ]
          },
          has_new_post_alert: {
            $gt: [
              {
                $size: {
                  $filter: {
                    input: '$alerts',
                    as: 'a',
                    cond: { $eq: ['$$a.alert_type', 'new_post'] }
                  }
                }
              },
              0
            ]
          },
          has_risk_detected: {
            $or: [
              { $in: ['$risk_level', ['medium', 'high', 'critical']] },
              { $gt: [{ $size: { $ifNull: ['$risk_factors', []] } }, 0] },
              {
                $gt: [
                  {
                    $size: {
                      $filter: {
                        input: '$alerts',
                        as: 'a',
                        cond: { $in: ['$$a.alert_type', ['keyword_risk', 'ai_risk']] }
                      }
                    }
                  },
                  0
                ]
              }
            ]
          }
        }
      });

      if (alert_type && alert_type !== 'all') {
        if (alert_type === 'risk') basePipeline.push({ $match: { has_risk_detected: true } });
        if (alert_type === 'viral' || alert_type === 'velocity') basePipeline.push({ $match: { has_viral_alert: true } });
        if (alert_type === 'new_post') basePipeline.push({ $match: { has_new_post_alert: true } });
      }

      // Filter by alert status (active, escalated, acknowledged, false_positive)
      if (status && status !== 'all') {
        basePipeline.push({ $match: { 'primary_alert.status': status } });
      }

      const itemsPipeline = [...basePipeline, { $sort: { published_at: -1 } }, { $skip: skip }, { $limit: limitNum }];
      const countPipeline = [...basePipeline, { $count: 'total' }];

      const [itemsResult, countResult] = await Promise.all([
        Content.aggregate(itemsPipeline),
        Content.aggregate(countPipeline)
      ]);

      items = itemsResult;
      total = countResult[0]?.total || 0;
    }

    const totalPages = Math.ceil(total / limitNum);

    res.status(200).json({
      items,
      pagination: {
        total,
        page: pageNum,
        totalPages,
        hasMore: pageNum < totalPages
      }
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get content (Paginated)
// @route   GET /api/content
// @access  Private
const getContent = async (req, res) => {
  try {
    const { platform, source_id, risk_level, media_type, content_type, limit = 100, page = 1, category } = req.query;

    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.max(1, parseInt(limit) || 20); // Default to 20 for sources page comfort
    const skip = (pageNum - 1) * limitNum;

    const basePipeline = [];
    const matchStage = withTenant(req, scopedDistrictQuery(req));

    if (platform && platform !== 'all') matchStage.platform = platform;
    if (source_id) matchStage.source_id = source_id;
    if (media_type) matchStage['media.type'] = media_type;
    if (content_type) matchStage.content_type = content_type;

    // Category filtering: pre-fetch source IDs matching the category
    if (category && category !== 'all') {
      const categoryQuery = withTenant(req, { category: category.toLowerCase() });
      if (platform && platform !== 'all') categoryQuery.platform = platform;
      const sourcesInCategory = await Source.find(categoryQuery).select('id').lean();
      const categorySourceIds = sourcesInCategory.map(s => s.id);

      if (categorySourceIds.length > 0) {
        if (matchStage.source_id) {
          // Intersect with explicit source_id
          if (categorySourceIds.includes(matchStage.source_id)) {
            // keep it
          } else {
            matchStage.source_id = { $in: ['__none__'] }; // no match
          }
        } else {
          matchStage.source_id = { $in: categorySourceIds };
        }
      } else {
        matchStage.source_id = { $in: ['__none__'] }; // no sources in this category
      }
    }

    if (Object.keys(matchStage).length > 0) {
      basePipeline.push({ $match: matchStage });
    }

    // Optimization: Pagination before lookups
    const itemsPipeline = [
      ...basePipeline,
      { $sort: { published_at: -1 } },
      { $skip: skip },
      { $limit: limitNum }
    ];

    itemsPipeline.push({
      $lookup: {
        from: 'analyses',
        let: { cid: '$id' },
        pipeline: [
          { $match: { $expr: { $eq: ['$content_id', '$$cid'] } } },
          { $sort: { analyzed_at: -1 } },
          { $limit: 1 }
        ],
        as: 'analysis'
      }
    });

    itemsPipeline.push({
      $unwind: {
        path: '$analysis',
        preserveNullAndEmptyArrays: true
      }
    });

    itemsPipeline.push({ $project: { _id: 0, __v: 0, 'analysis._id': 0, 'analysis.__v': 0 } });

    // Join Alerts to get risk details
    itemsPipeline.push({
      $lookup: {
        from: 'alerts',
        let: { contentId: '$id' },
        pipeline: [
          { $match: { $expr: { $eq: ['$content_id', '$$contentId'] } } },
          { $sort: { created_at: -1 } },
          { $limit: 1 }
        ],
        as: 'alerts'
      }
    });

    itemsPipeline.push({
      $addFields: {
        primary_alert: { $arrayElemAt: ['$alerts', 0] }
      }
    });

    if (risk_level && risk_level !== 'all') {
      itemsPipeline.push({ $match: { 'analysis.risk_level': risk_level } });
    }

    const [items, total] = await Promise.all([
      Content.aggregate(itemsPipeline),
      Content.countDocuments(matchStage)
    ]);

    const totalPages = Math.ceil(total / limitNum);

    res.status(200).json({
      items,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages,
        hasMore: pageNum < totalPages
      }
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get content stats (Fast Aggregation)
// @route   GET /api/content/stats
// @access  Private
const getContentStats = async (req, res) => {
  try {
    const { platform, source_id, media_type } = req.query;
    const matchStage = withTenant(req, scopedDistrictQuery(req));

    if (platform && platform !== 'all') matchStage.platform = platform;
    if (source_id) matchStage.source_id = source_id;
    if (media_type) matchStage['media.type'] = media_type;
    // This avoids $lookup and works purely on indexes if available
    const [totalCount, highRiskCount, criticalRiskCount, mediumRiskCount, sourcesCount] = await Promise.all([
      Content.countDocuments(matchStage),
      Content.countDocuments({ ...matchStage, risk_level: 'high' }),
      Content.countDocuments({ ...matchStage, risk_level: 'critical' }),
      Content.countDocuments({ ...matchStage, risk_level: 'medium' }),
      Promise.resolve(0)
    ]);

    res.status(200).json({
      totalTweets: totalCount,
      highRisk: highRiskCount,
      criticalRisk: criticalRiskCount,
      mediumRisk: mediumRiskCount
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get content detail
// @route   GET /api/content/:id
// @access  Private
const getContentDetail = async (req, res) => {
  try {
    const pipeline = [
      { $match: withTenant(req, { id: req.params.id, ...scopedDistrictQuery(req) }) },
      {
        $lookup: {
          from: 'analyses',
          localField: 'content_id',
          foreignField: 'content_id',
          as: 'analysis'
        }
      },
      {
        $unwind: {
          path: '$analysis',
          preserveNullAndEmptyArrays: true
        }
      },
      {
        $lookup: {
          from: 'sources',
          localField: 'source_id',
          foreignField: 'id',
          as: 'source'
        }
      },
      {
        $unwind: {
          path: '$source',
          preserveNullAndEmptyArrays: true
        }
      },
      { $project: { _id: 0, __v: 0, 'analysis._id': 0, 'analysis.__v': 0, 'source._id': 0, 'source.__v': 0 } }
    ];

    const result = await Content.aggregate(pipeline);

    if (!result || result.length === 0) {
      return res.status(404).json({ message: 'Content not found' });
    }

    res.status(200).json(result[0]);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Run availability check for Instagram content
// @route   POST /api/content/check-availability
// @access  Private
const checkContentAvailability = async (req, res) => {
  try {
    const { runFullAvailabilityCheck } = require('../services/availabilityCheckerService');
    const { batchSize = 50, platform = 'instagram', forceRecheck = false } = req.body || {};
    const stats = await runFullAvailabilityCheck({ batchSize, platform, forceRecheck });
    res.json({
      message: 'Availability check completed',
      ...stats
    });
  } catch (error) {
    console.error('[ContentController] checkAvailability error:', error);
    res.status(500).json({ message: 'Availability check failed', error: error.message });
  }
};

// @desc    Get content that has been deleted or expired on the original platform
// @route   GET /api/content/unavailable
// @access  Private
const getUnavailableContent = async (req, res) => {
  try {
    const { platform, status = 'all', limit = 50, page = 1 } = req.query;
    const filter = withTenant(req, scopedDistrictQuery(req));

    if (platform && platform !== 'all') filter.platform = platform;

    if (status === 'deleted') {
      filter.is_deleted = true;
    } else if (status === 'expired') {
      filter.is_expired = true;
    } else {
      // 'all' — show both deleted and expired
      filter.$or = [{ is_deleted: true }, { is_expired: true }];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [items, total] = await Promise.all([
      Content.find(filter)
        .sort({ deleted_at: -1, expired_at: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Content.countDocuments(filter)
    ]);

    res.json({
      items,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        hasMore: skip + items.length < total
      }
    });
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch unavailable content', error: error.message });
  }
};

module.exports = {
  getContent,
  getContentFeed,
  getContentStats,
  getContentDetail,
  checkContentAvailability,
  getUnavailableContent
};
