// server/controllers/course.controller.js
const Course = require("../models/Course.model");
const Review = require("../models/Review.model"); // Make sure you have this model

// ── GET /api/courses ──────────────────────────────────────────────────────────
// Public: get all published courses
const getAllCourses = async (req, res) => {
  try {
    const courses = await Course.find({ status: "published" })
      .populate("instructor", "name email title avatar bio")
      .select("-sections") // Exclude sections for performance
      .sort({ createdAt: -1 });

    res.status(200).json(courses);
  } catch (error) {
    console.error("Get all courses error:", error);
    res.status(500).json({ message: "Could not fetch courses." });
  }
};

// ── GET /api/courses/:id ──────────────────────────────────────────────────────
// Public: get a single course by ID (with FULL data including sections)
const getCourseById = async (req, res) => {
  try {
    const course = await Course.findById(req.params.id)
      .populate("instructor", "name email title avatar bio")
      .populate({
        path: "alsoBoughtCourseIds",
        select: "title price discountPrice thumbnail rating reviews students category emoji color",
        match: { status: "published" },
      });

    if (!course) {
      return res.status(404).json({ message: "Course not found." });
    }

    // Fetch reviews for this course
    const reviews = await Review.find({ course: req.params.id })
      .populate("student", "name avatar")
      .sort({ createdAt: -1 })
      .limit(50);

    // Map reviews to the format expected by frontend
    const reviews_list = reviews.map((r) => ({
      id: r._id,
      author: r.student?.name || "Anonymous",
      avatar: r.student?.avatar || "",
      rating: r.rating,
      text: r.comment || "",
      date: r.createdAt ? new Date(r.createdAt).toLocaleDateString() : "Recently",
      verified: true,
    }));

    // Return course with reviews
    res.status(200).json({
      ...course.toObject(),
      reviews_list,
    });
  } catch (error) {
    console.error("Get course by ID error:", error);
    res.status(500).json({ message: "Could not fetch course." });
  }
};

// ── GET /api/courses/instructor/my-courses ────────────────────────────────────
// Instructor only: get all courses created by this instructor
const getInstructorCourses = async (req, res) => {
  try {
    const courses = await Course.find({ instructor: req.user._id }).sort({
      createdAt: -1,
    });

    res.status(200).json(courses);
  } catch (error) {
    console.error("Get instructor courses error:", error);
    res.status(500).json({ message: "Could not fetch your courses." });
  }
};

// ── POST /api/courses ─────────────────────────────────────────────────────────
// Instructor only: create a new course
const createCourse = async (req, res) => {
  try {
    const {
      title,
      subtitle,
      description,
      category,
      price,
      discountPrice,
      status,
      sections,
      thumbnail,
      previewVideoUrl,
      whatYouLearn,
      requirements,
      tags,
      imageTestimonials,
      videoTestimonials,
      projectGallery,
      alsoBoughtCourseIds,
      level,
      language,
      duration,
    } = req.body;

    if (!title) {
      return res.status(400).json({ message: "Course title is required." });
    }

    const course = await Course.create({
      title,
      subtitle: subtitle || "",
      description: description || "",
      category: category || "General",
      price: price || 0,
      discountPrice: discountPrice || 0,
      status: status || "draft",
      sections: sections || [],
      thumbnail: thumbnail || "",
      previewVideoUrl: previewVideoUrl || "",
      whatYouLearn: Array.isArray(whatYouLearn) ? whatYouLearn : [],
      requirements: Array.isArray(requirements) ? requirements : [],
      tags: Array.isArray(tags) ? tags : [],
      instructor: req.user._id,
      imageTestimonials: Array.isArray(imageTestimonials) ? imageTestimonials : [],
      videoTestimonials: Array.isArray(videoTestimonials) ? videoTestimonials : [],
      projectGallery: Array.isArray(projectGallery) ? projectGallery : [],
      alsoBoughtCourseIds: Array.isArray(alsoBoughtCourseIds) ? alsoBoughtCourseIds : [],
      level: level || "Beginner",
      language: language || "English",
      duration: duration || "",
    });

    res.status(201).json({ message: "Course created successfully!", course });
  } catch (error) {
    console.error("Create course error:", error.message);
    res.status(500).json({ message: "Could not create course." });
  }
};

// ── PUT /api/courses/:id ──────────────────────────────────────────────────────
// Instructor only: update their own course
const updateCourse = async (req, res) => {
  try {
    const course = await Course.findById(req.params.id);

    if (!course) {
      return res.status(404).json({ message: "Course not found." });
    }

    // Make sure instructor owns this course
    if (course.instructor.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: "You can only edit your own courses." });
    }

    const {
      title,
      subtitle,
      description,
      category,
      price,
      discountPrice,
      status,
      sections,
      thumbnail,
      previewVideoUrl,
      whatYouLearn,
      requirements,
      tags,
      imageTestimonials,
      videoTestimonials,
      projectGallery,
      alsoBoughtCourseIds,
      level,
      language,
      duration,
    } = req.body;

    // Update fields
    course.title = title ?? course.title;
    course.subtitle = subtitle ?? course.subtitle;
    course.description = description ?? course.description;
    course.category = category ?? course.category;
    course.price = price ?? course.price;
    course.discountPrice = discountPrice ?? course.discountPrice;
    course.status = status ?? course.status;
    course.sections = sections ?? course.sections;
    course.thumbnail = thumbnail ?? course.thumbnail;
    course.previewVideoUrl = previewVideoUrl ?? course.previewVideoUrl;
    course.level = level ?? course.level;
    course.language = language ?? course.language;
    course.duration = duration ?? course.duration;

    if (Array.isArray(whatYouLearn)) course.whatYouLearn = whatYouLearn;
    if (Array.isArray(requirements)) course.requirements = requirements;
    if (Array.isArray(tags)) course.tags = tags;
    if (Array.isArray(imageTestimonials)) course.imageTestimonials = imageTestimonials;
    if (Array.isArray(videoTestimonials)) course.videoTestimonials = videoTestimonials;
    if (Array.isArray(projectGallery)) course.projectGallery = projectGallery;
    if (Array.isArray(alsoBoughtCourseIds)) course.alsoBoughtCourseIds = alsoBoughtCourseIds;

    const updated = await course.save();

    res.status(200).json({ message: "Course updated successfully!", course: updated });
  } catch (error) {
    console.error("Update course error:", error);
    res.status(500).json({ message: "Could not update course." });
  }
};

// ── DELETE /api/courses/:id ───────────────────────────────────────────────────
// Instructor only: delete their own course
const deleteCourse = async (req, res) => {
  try {
    const course = await Course.findById(req.params.id);

    if (!course) {
      return res.status(404).json({ message: "Course not found." });
    }

    if (course.instructor.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: "You can only delete your own courses." });
    }

    await course.deleteOne();

    res.status(200).json({ message: "Course deleted successfully." });
  } catch (error) {
    console.error("Delete course error:", error);
    res.status(500).json({ message: "Could not delete course." });
  }
};

module.exports = {
  getAllCourses,
  getCourseById,
  getInstructorCourses,
  createCourse,
  updateCourse,
  deleteCourse,
};