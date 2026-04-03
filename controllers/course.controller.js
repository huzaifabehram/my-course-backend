// server/controllers/course.controller.js
// ─── Course CRUD: create, read, update, delete ────────────────────────────────

const Course = require("../models/Course.model");

// ── GET /api/courses ──────────────────────────────────────────────────────────
// Public: get all published courses
const getAllCourses = async (req, res) => {
  try {
    const courses = await Course.find({ status: "published" })
      .populate("instructor", "name email title avatar")
      .sort({ createdAt: -1 });

    res.status(200).json({ courses });
  } catch (error) {
    res.status(500).json({ message: "Could not fetch courses." });
  }
};

// ── GET /api/courses/:id ──────────────────────────────────────────────────────
// Public: get a single course by ID
const getCourseById = async (req, res) => {
  try {
    const course = await Course.findById(req.params.id).populate(
      "instructor",
      "name email title avatar bio"
    );

    if (!course) {
      return res.status(404).json({ message: "Course not found." });
    }

    res.status(200).json({ course });
  } catch (error) {
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

    res.status(200).json({ courses });
  } catch (error) {
    res.status(500).json({ message: "Could not fetch your courses." });
  }
};

// ── POST /api/courses ─────────────────────────────────────────────────────────
// Instructor only: create a new course
const createCourse = async (req, res) => {
  try {
    const { title, description, category, price, status, sections, thumbnail } =
      req.body;

    if (!title) {
      return res.status(400).json({ message: "Course title is required." });
    }

    const course = await Course.create({
      title,
      description,
      category,
      price: price || 0,
      status: status || "draft",
      sections: sections || [],
      thumbnail: thumbnail || "",
      instructor: req.user._id,
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

    const { title, description, category, price, status, sections, thumbnail } =
      req.body;

    course.title = title ?? course.title;
    course.description = description ?? course.description;
    course.category = category ?? course.category;
    course.price = price ?? course.price;
    course.status = status ?? course.status;
    course.sections = sections ?? course.sections;
    course.thumbnail = thumbnail ?? course.thumbnail;

    const updated = await course.save();

    res.status(200).json({ message: "Course updated successfully!", course: updated });
  } catch (error) {
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
