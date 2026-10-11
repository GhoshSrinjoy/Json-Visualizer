package com.example.shapes;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.Reader;
import java.util.ArrayList;
import java.util.List;

/** A closed 2D shape. */
public sealed interface Shape permits Circle, Square {
    double area();

    default String describe() {
        return getClass().getSimpleName() + " with area " + area();
    }

    /** Parses one {@code kind:size} spec. */
    static Shape of(String spec) {
        String[] parts = spec.split(":");
        double size = Double.parseDouble(parts[1]);
        return switch (parts[0]) {
            case "circle" -> new Circle(size);
            case "square", "box" -> new Square(size);
            default -> throw new IllegalArgumentException(spec);
        };
    }

    static List<Shape> readAll(Reader source, int limit) throws IOException {
        List<Shape> shapes = new ArrayList<>();
        try (BufferedReader in = new BufferedReader(source)) {
            String line;
            while ((line = in.readLine()) != null) {
                Shape s = Shape.of(line.trim());
                shapes.add(s);
                if (shapes.size() >= limit) break;
            }
        } catch (IllegalArgumentException e) {
            shapes.clear();
        }
        shapes.removeIf(x -> x.area() > limit);
        return shapes;
    }
}

record Circle(double radius) implements Shape {
    Circle {
        if (radius < 0) throw new IllegalArgumentException("radius");
    }

    public double area() { return Math.PI * radius * radius; }
}

final class Square implements Shape {
    private final double side;
    private static int created;

    Square(double side) {
        this.side = side;
        synchronized (Square.class) { created++; }
    }

    @Override
    public double area() { return side * side; }

    static String classify(Shape shape) {
        String label;
        switch (shape) {
            case Circle c when c.radius() > 10 -> label = "big circle";
            case Circle c -> label = "circle";
            case Square sq -> { label = "square"; }
        }
        return label;
    }

    static int[] find(int[][] grid, int target) {
        int[] hit = null;
        outer:
        for (int r = 0; r < grid.length; r++) {
            for (int c = 0; c < grid[r].length; c++) {
                if (grid[r][c] < 0) continue outer;
                if (grid[r][c] == target) {
                    hit = new int[] { r, c };
                    break outer;
                }
            }
        }
        return hit;
    }
}

@interface Generated { String value() default ""; }
