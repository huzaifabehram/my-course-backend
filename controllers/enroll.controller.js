// server/controllers/enroll.controller.js
// ─── Enrollment logic ─────────────────────────────────────────────────────────

const User = require("../models/User.model");
const Course = require("../models/Course.model");

// ── POST /api/enroll ──────────────────────────────────────────────────────────
// Student only: enroll in a course
const enrollCourse = async (req, res) => {
  try {
    const { courseId } = req.body;

    if (!courseId) {
      return res.status(400).json({ message: "courseId is required." });
    }

    // Find the course
    const course = await Course.findById(courseId);
    if (!course) {
      return res.status(404).json({ message: "Course not found." });
    }

    if (course.status !== "published") {
      return res.status(400).json({ message: "This course is not available for enrollment." });
    }

    // Find the student
    const student = await User.findById(req.user._id);

    // Check if already enrolled
    if (student.enrolledCourses.includes(courseId)) {
      return res.status(400).json({ message: "You are already enrolled in this course." });
    }

    // Add course to student's enrolled list
    student.enrolledCourses.push(courseId);
    await student.save();

    // Increment course enrollment count and revenue
    course.studentsEnrolled += 1;
    course.revenue += course.price;
    await course.save();

    res.status(200).json({
      message: `Successfully enrolled in "${course.title}"!`,
      courseId,
    });
  } catch (error) {
    console.error("Enroll error:", error.message);
    res.status(500).json({ message: "Enrollment failed." });
  }
};

// ── GET /api/my-courses ───────────────────────────────────────────────────────
// Student only: get all courses this student is enrolled in
const getMyCourses = async (req, res) => {
  try {
    const student = await User.findById(req.user._id).populate({
      path: "enrolledCourses",
      populate: { path: "instructor", select: "name avatar title" },
    });

    res.status(200).json({ courses: student.enrolledCourses });
  } catch (error) {
    res.status(500).json({ message: "Could not fetch enrolled courses." });
  }
};

module.exports = { enrollCourse, getMyCourses };
