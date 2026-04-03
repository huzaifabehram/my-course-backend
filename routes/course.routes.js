// server/routes/course.routes.js

const express = require("express");
const router = express.Router();
const {
  getAllCourses,
  getCourseById,
  getInstructorCourses,
  createCourse,
  updateCourse,
  deleteCourse,
} = require("../controllers/course.controller");
const { protect, restrictTo } = require("../middleware/auth.middleware");

// GET  /api/courses              → Public: all published courses
router.get("/", getAllCourses);

// GET  /api/courses/instructor/my-courses → Instructor only
router.get(
  "/instructor/my-courses",
  protect,
  restrictTo("instructor"),
  getInstructorCourses
);

// GET  /api/courses/:id          → Public: single course
router.get("/:id", getCourseById);

// POST /api/courses              → Instructor only: create course
router.post("/", protect, restrictTo("instructor"), createCourse);

// PUT  /api/courses/:id          → Instructor only: update course
router.put("/:id", protect, restrictTo("instructor"), updateCourse);

// DELETE /api/courses/:id        → Instructor only: delete course
router.delete("/:id", protect, restrictTo("instructor"), deleteCourse);

module.exports = router;
