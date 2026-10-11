require 'json'
require_relative 'models/user'

module App
  # Loads users from a JSON file.
  class UserLoader < Base
    include Enumerable
    attr_reader :path

    def initialize(path)
      @path = path
    end

    def self.build(path)
      new(path)
    end

    class << self
      def default
        build("users.json")
      end
    end

    def load(limit = 10)
      data = JSON.parse(File.read(@path))
      result = []
      if data.nil?
        raise ArgumentError, "nil"
      elsif data.empty?
        return []
      else
        data.each do |item|
          next if item["disabled"]
          result << User.new(item["name"])
          break if result.size >= limit
        end
      end
      begin
        validate(result)
      rescue StandardError => e
        puts e.message
      ensure
        log(result)
      end
      case result.size
      when 0
        puts "none"
      when 1, 2
        puts "few"
      else
        puts "many"
      end
      while limit > 0
        limit -= 1
      end
      unless result.empty?
        puts "ok"
      end
      result
    end

    private

    def validate(users)
      users.all? { |u| u.valid? }
    end

    def fetch(attempts)
      tries = 0
      until tries >= attempts
        tries += 1
      end
      for n in 1..attempts do
        log(n)
      end
      read_remote
    rescue IOError => e
      retry if attempts > 1
      raise
    ensure
      close
    end
  end
end
