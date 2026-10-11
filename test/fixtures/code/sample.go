package main

import (
	"fmt"
	"os"
	str "strings"
	"example.com/app/internal/util"
	_ "image/png"
	. "math"
)

// MaxUsers caps how many users are loaded.
const MaxUsers = 100

const MinAge, MaxAge = 18, 120

var (
	verbose bool
	cache   = map[string]User{}
)

type User struct {
	Name string
	Age  int
}

type Greeter interface {
	Greet() string
}

func (u *User) Greet() string {
	return fmt.Sprintf("hi %s", u.Name)
}

func LoadUsers(path string, limit int) ([]User, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	} else if len(data) == 0 {
		return nil, fmt.Errorf("empty")
	}
	var result []User
	for i := 0; i < limit; i++ {
		if i%2 == 0 {
			continue
		}
		u := User{Name: str.ToUpper("x"), Age: i}
		result = append(result, u)
		if len(result) > 5 {
			break
		}
	}
	for _, r := range result {
		util.Log(r)
	}
	switch len(result) {
	case 0:
		fmt.Println("none")
	case 1, 2:
		fmt.Println("few")
		fallthrough
	default:
		fmt.Println("many")
	}
	defer cleanup()
	go func() { fmt.Println("async") }()
	return result, nil
}

func cleanup() {}

// Rights is declared before its receiver type.
func (a Admin) Rights() []Role { return nil }

// Admin is a user with extra rights.
type Admin struct {
	User
	Level, Rank int
}

type Role = string

// Promote raises the level and records the user.
func (a *Admin) Promote(u User) {
	a.Level++
	u.Age = a.Level
	cache[u.Name] = u
	notify := func(msg string) { util.Log(msg, a.Level) }
	notify("promoted")
}

func (c *Client) Fetch(id string) error { return nil }

// Classify covers if initializers, type switches, select and labeled loops.
func Classify(v interface{}, ch chan int, done chan bool) (string, error) {
	if s, ok := v.(fmt.Stringer); ok {
		return s.String(), nil
	}
	switch t := v.(type) {
	case int, int64:
		return fmt.Sprint(t), nil
	case string:
		return t, nil
	}
outer:
	for {
		select {
		case n := <-ch:
			for n > 0 {
				n--
				if n == 3 {
					continue outer
				}
			}
		case <-done:
			break outer
		}
	}
	switch {
	case Sqrt(2) > 1:
		panic("unreachable")
	}
	return "", nil
}
